import { useState } from 'react'
import { supabase } from './supabase.js'

function Login({ onLoginSuccess }) {
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  

  async function handleLogin() {
  try {
    setLoading(true)
    setError(null)

    const { data, error } = await supabase
      .from('shop_owners')
      .select('*')
      .eq('phone_number', phone)
      .eq('password', password)
      .single()

    console.log("LOGIN DATA:", data)
    console.log("LOGIN ERROR:", error)

    if (error || !data) {
      setError("Invalid credentials")
      return
    }

    // ✅ STEP 1 FIX: ensure id exists
    if (!data.id) {
      console.error("❌ No ID in shop_owners table")
      setError("Database issue: missing shop id")
      return
    }

    // ✅ STEP 2 FIX: store correctly
    localStorage.setItem('store_id', String(data.id))
    localStorage.setItem('styleflow_owner', JSON.stringify(data))

    console.log("✅ STORED STORE ID:", data.id)

    onLoginSuccess(data)

  } catch (err) {
    console.error(err)
    setError("Login failed")
  } finally {
    setLoading(false)
  }
}

  return (
    <div style={styles.container}>
      <div style={styles.card}>

        <div style={styles.logoBox}>
          <h1 style={styles.logo}>🛍️ StyleFlow</h1>
          <p style={styles.subtitle}>Merchant Dashboard</p>
        </div>

        {error && (
          <div style={styles.errorBox}>
            ❌ {error}
          </div>
        )}

        <div style={styles.inputGroup}>
          <label style={styles.label}>📱 Phone Number</label>
          <input
            style={styles.input}
            type="tel"
            placeholder="Enter your phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <div style={styles.inputGroup}>
          <label style={styles.label}>🔒 Password</label>
          <input
            style={styles.input}
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button
          style={{
            ...styles.loginBtn,
            opacity: loading ? 0.7 : 1
          }}
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? '⏳ Logging in...' : '🚀 Login'}
        </button>

      </div>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#f5f5f5',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'Arial, sans-serif',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: '16px',
    padding: '40px',
    width: '100%',
    maxWidth: '400px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.1)',
  },
  logoBox: {
    textAlign: 'center',
    marginBottom: '32px',
  },
  logo: {
    margin: 0,
    fontSize: '32px',
    color: '#333',
  },
  subtitle: {
    margin: '8px 0 0',
    color: '#999',
    fontSize: '14px',
  },
  errorBox: {
    backgroundColor: '#ffebee',
    border: '1px solid #ffcdd2',
    borderRadius: '8px',
    padding: '12px',
    marginBottom: '16px',
    color: '#c62828',
    fontSize: '14px',
    textAlign: 'center',
  },
  inputGroup: {
    marginBottom: '20px',
  },
  label: {
    display: 'block',
    marginBottom: '8px',
    fontSize: '14px',
    color: '#555',
    fontWeight: 'bold',
  },
  input: {
    width: '100%',
    padding: '12px 16px',
    borderRadius: '8px',
    border: '1px solid #ddd',
    fontSize: '15px',
    outline: 'none',
    boxSizing: 'border-box',
    backgroundColor: '#fafafa',
  },
  loginBtn: {
    width: '100%',
    padding: '14px',
    backgroundColor: '#4CAF50',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '16px',
    fontWeight: 'bold',
    cursor: 'pointer',
    marginTop: '8px',
  },
}

export default Login