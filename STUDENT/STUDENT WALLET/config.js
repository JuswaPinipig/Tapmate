// Same Supabase project as the login page.
window.APP_CONFIG = {
    SUPABASE_URL: "https://inoafkspgsxzxarzboqq.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z",
    // Paths from THIS page (STUDENT/STUDENT WALLET/)
    LOGIN_URL: "../../LOGIN/login.html",
    HISTORY_URL: "../HISTORY/studenthistory.html",   // e.g. "../STUDENT HISTORY/studenthistory.html"
    TOPUP_URL: "../TOP-UP/student-top-up.html",
    // Parent page that redeems the QR / 6-digit code. QR encodes: PARENT_LINK_URL + "?link=<token>"
    PARENT_LINK_URL: "../../PARENT/PARENT SIGNUP/PARENT_SIGN_UP.html"   // path from THIS page (STUDENT/STUDENT WALLET/)
};