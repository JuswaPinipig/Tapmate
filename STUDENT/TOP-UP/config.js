// Same Supabase project as the wallet and login pages.
window.APP_CONFIG = {
    SUPABASE_URL: "https://inoafkspgsxzxarzboqq.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z",
    // Paths from THIS page (STUDENT/STUDENT TOP UP/)
    LOGIN_URL: "../../LOGIN/login.html",
    WALLET_URL: "../STUDENT WALLET/studentwallet.html",
    HISTORY_URL: "../HISTORY/studenthistory.html",
    GCASH_QR: "assets/GCash QR.jpg",   // relative to this page: TOP-UP/assets/
    // Display / app settings (no business rules here: amounts, reference length, file size live in the database)
    SESSION_KEY: "tapmate_session",   // must match the login page
    LOCALE: "en-PH",
    CURRENCY_SYMBOL: "₱",
    POLL_MS: 15000,
};