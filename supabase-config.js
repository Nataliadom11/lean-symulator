// Wklej tutaj dane z okna Connect w Supabase.
// Publishable key jest przeznaczony do aplikacji frontendowej.
const SUPABASE_URL = "https://aughzpwfzbejewlalwmz.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_mdECiaTQsQq_u3RMEG9uPg_e4w5R1xe";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);
