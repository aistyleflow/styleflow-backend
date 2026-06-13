import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://deefmbwxchyzropdffhp.supabase.co'
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlZWZtYnd4Y2h5enJvcGRmZmhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2NzQyOTQsImV4cCI6MjA5NTI1MDI5NH0.ZlsxOyVAOM8yhGjnERPrGDqfHQmxfnqSvCQb3LOCX9k'

export const supabase = createClient(
  supabaseUrl,
  supabaseKey
)