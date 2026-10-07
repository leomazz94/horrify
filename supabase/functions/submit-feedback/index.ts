import { createClient } from '@supabase/supabase-js';
import { createFeedbackHandler } from './core.mjs';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
// POST requests authenticate the actual user's JWT with Auth.getUser before any write.
Deno.serve(createFeedbackHandler({db,env:name=>Deno.env.get(name)}));
