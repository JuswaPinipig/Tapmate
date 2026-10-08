/* =====================================================================
   TapMate | Audit logger
   Include this on every admin page that changes data, after creating
   your Supabase client:

     <script src="../AUDIT LOGS/auditlogger.js"></script>
     const audit = TapMateAudit.create(sb);

   Then call it right after a change succeeds:

     await audit.log({
         module: 'accounts',                       // accounts | products | pay_later | top_up | security
         action: 'update',                         // see the CHECK list in adminauditlogs.sql
         summary: `Edited the account of ${fullName} (${studentId})`,
         target: { type: 'account', id: acct.id, label: `${fullName} (${studentId})` },
         before: { daily_limit: 150, pay_later: false },   // null when creating
         after:  { daily_limit: 300, pay_later: true }     // null when removing
     });

   Tips
   - Pass only the fields an admin can see or edit. Never pass PINs or passwords.
   - Log after the change succeeds, so the log never claims something that didn't happen.
   ===================================================================== */
(function (global) {
    'use strict';

    // The admin pages sign in with RFID + PIN and keep a card token in sessionStorage.
    function cardToken() {
        try { return (JSON.parse(sessionStorage.getItem('tapmate_session')) || {}).token || ''; }
        catch (_) { return ''; }
    }
    const pick = (obj, keys) => {
        for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '' && String(obj[k]).trim() !== '-') return String(obj[k]).trim();
        return null;
    };

    // card_session may not include the card number, so ask the admin profile RPC (migration v6/v8) as a backup.
    async function rfidFromProfile(sb, token) {
        try {
            const { data, error } = await sb.rpc('admin_get_own_profile', { p_token: token });
            if (!error && data) return pick(data, ['rfid_uid']);
        } catch (_) { /* fall through */ }
        return null;
    }

    /**
     * Returns the signed-in admin's details for the log snapshot.
     * 1) Preferred: the same card_session RPC the admin pages already use, so the
     *    admin ID, name and RFID come from the real session, not from metadata that may be empty.
     * 2) Fallback: Supabase Auth user_metadata ({ admin_code, rfid, full_name }).
     * ADAPT ME: if card_session names these fields differently, add the names to the lists below.
     * Tip: run `sb.rpc('card_session', { p_token })` once in the console to see which fields it returns.
     */
    async function currentAdmin(sb) {
        const token = cardToken();
        if (token) {
            const { data, error } = await sb.rpc('card_session', { p_token: token });
            if (!error && data && data.role === 'admin') {
                // `rfid_uid` is the real column name on the accounts table; the rest are fallbacks.
                let rfid = pick(data, ['rfid_uid', 'rfid', 'rfid_number', 'rfid_no', 'card_uid', 'card_number', 'card_id', 'card']);
                if (!rfid) rfid = await rfidFromProfile(sb, token);
                if (!rfid) console.warn('Audit logger: card_session returned no RFID field. Add its name in auditlogger.js (currentAdmin).', Object.keys(data));
                return {
                    id: pick(data, ['user_id', 'id', 'account_id', 'uid']),
                    code: pick(data, ['employee_id', 'admin_code', 'admin_id', 'code']) || 'UNASSIGNED',
                    rfid,
                    name: pick(data, ['full_name', 'name', 'display_name']) || 'Admin'
                };
            }
        }
        const { data, error } = await sb.auth.getUser();
        if (error || !data || !data.user) throw new Error('No signed-in admin');
        const u = data.user, m = u.user_metadata || {};
        return {
            id: u.id,
            code: m.admin_code || 'UNASSIGNED',
            rfid: pick(m, ['rfid']),
            name: m.full_name || m.name || u.email || 'Admin'
        };
    }

    function create(sb) {
        let cached = null;
        return {
            async log(entry) {
                try {
                    cached = cached || await currentAdmin(sb);
                    const t = entry.target || {};
                    const { error } = await sb.from('audit_logs').insert({
                        admin_id: cached.id,
                        admin_code: cached.code,
                        admin_rfid: cached.rfid,
                        admin_name: cached.name,
                        module: entry.module,
                        action: entry.action,
                        summary: entry.summary,
                        target_type: t.type || null,
                        target_id: t.id != null ? String(t.id) : null,
                        target_label: t.label || null,
                        before_data: entry.before ?? null,
                        after_data: entry.after ?? null
                    });
                    if (error) throw error;
                    return true;
                } catch (err) {
                    // A logging problem shouldn't undo the admin's change, but it must not fail silently.
                    console.error('Audit log failed:', err);
                    return false;
                }
            }
        };
    }

    global.TapMateAudit = { create, currentAdmin };
})(window);