import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'
import Login from './Login.js'

function App() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [owner, setOwner] = useState(null)

  useEffect(() => {
    const saved = localStorage.getItem('styleflow_owner')
    if (saved) {
      setOwner(JSON.parse(saved))
    }
  }, [])

  useEffect(() => {
  if (owner) {
    fetchOrders()
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [owner])

  function handleLoginSuccess(ownerData) {
    localStorage.setItem('styleflow_owner', JSON.stringify(ownerData))
    setOwner(ownerData)
  }

  function handleLogout() {
    localStorage.removeItem('styleflow_owner')
    setOwner(null)
    setOrders([])
  }

 async function fetchOrders() {
  try {
    setLoading(true)
    setError(null)

    const { data, error } = await supabase
      .from('orders')
      .select(`
        *,
        order_items (
          *
        )
      `)
      .eq('store_id', owner.id) // ✅ fixed — store_id
      .order('created_at', { ascending: false })

    if (error) {
      console.error('❌ Error:', error.message)
      setError(error.message)
      return
    }

    console.log('✅ Orders fetched:', data.length)
    setOrders(data)

  } catch (err) {
    setError(err.message)
  } finally {
    setLoading(false)
  }
}

  async function updateStatus(orderId, newStatus) {
    const { error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', orderId)

    if (error) {
      console.error('❌ Status update error:', error.message)
      return
    }

    fetchOrders()
  }

  function getStatusColor(status) {
    switch (status) {
      case 'pending':   return '#FFA500'
      case 'confirmed': return '#2196F3'
      case 'shipped':   return '#9C27B0'
      case 'delivered': return '#4CAF50'
      case 'cancelled': return '#F44336'
      default:          return '#999'
    }
  }

  if (!owner) {
    return <Login onLoginSuccess={handleLoginSuccess} />
  }

  return (
    <div style={styles.container}>

      <div style={styles.header}>
        <h1 style={styles.title}>🛍️ StyleFlow Dashboard</h1>
        <div style={styles.headerRight}>
          <span style={styles.ownerName}>👤 {owner.name || owner.phone_number}</span>
          <button style={styles.refreshBtn} onClick={fetchOrders}>
            🔄 Refresh
          </button>
          <button style={styles.logoutBtn} onClick={handleLogout}>
            🚪 Logout
          </button>
        </div>
      </div>

      <div style={styles.statsBar}>
        {[
          { label: 'Total Orders',  value: orders.length,                                         color: '#333'    },
          { label: '⏳ Pending',    value: orders.filter(o => o.status === 'pending').length,   color: '#FFA500' },
          { label: '✅ Confirmed',  value: orders.filter(o => o.status === 'confirmed').length, color: '#2196F3' },
          { label: '🚚 Shipped',    value: orders.filter(o => o.status === 'shipped').length,   color: '#9C27B0' },
          { label: '📦 Delivered',  value: orders.filter(o => o.status === 'delivered').length, color: '#4CAF50' },
        ].map((stat) => (
          <div key={stat.label} style={styles.statCard}>
            <span style={{ ...styles.statNumber, color: stat.color }}>{stat.value}</span>
            <span style={styles.statLabel}>{stat.label}</span>
          </div>
        ))}
      </div>

      {loading && (
        <div style={styles.center}>
          <p style={styles.loadingText}>⏳ Loading orders...</p>
        </div>
      )}

      {error && (
        <div style={styles.errorBox}>
          <p>❌ Error: {error}</p>
          <button style={styles.retryBtn} onClick={fetchOrders}>Retry</button>
        </div>
      )}

      {!loading && !error && orders.length === 0 && (
        <div style={styles.center}>
          <p style={styles.emptyText}>📭 No orders yet.</p>
          <p style={styles.emptySubText}>
            Orders will appear here when customers place them.
          </p>
        </div>
      )}

      {!loading && !error && orders.length > 0 && (
        <div style={styles.ordersList}>
          {orders.map((order) => (
            <div key={order.id} style={styles.orderCard}>

              <div style={styles.orderHeader}>
                <div>
                  <p style={styles.orderId}>
                    🆔 {String(order.id).slice(0, 8)}...
                  </p>
                  <p style={styles.orderDate}>
                    🕐 {new Date(order.created_at).toLocaleString()}
                  </p>
                </div>
                <span style={{
                  ...styles.statusBadge,
                  backgroundColor: getStatusColor(order.status)
                }}>
                  {order.status.toUpperCase()}
                </span>
              </div>

              <div style={styles.customerDetails}>
                <p>👤 <strong>{order.customer_name || 'N/A'}</strong></p>
                <p>📱 {order.phone_number}</p>
                <p>📍 {order.customer_address || 'N/A'}</p>
              </div>

              {order.order_items && order.order_items.length > 0 && (
                <div style={styles.itemsBox}>
                  <p style={styles.itemsTitle}>🛍️ Items Ordered:</p>
                  {order.order_items.map((item, index) => (
                    <div key={index} style={styles.itemRow}>
                      <span>Product ID: {String(item.product_id).slice(0, 8)}...</span>
                      <span style={styles.itemQty}>× {item.quantity}</span>
                    </div>
                  ))}
                </div>
              )}

              <div style={styles.statusButtons}>
                <p style={styles.updateLabel}>Update Status:</p>
                <div style={styles.btnRow}>
                  {['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'].map((status) => (
                    <button
                      key={status}
                      style={{
                        ...styles.statusBtn,
                        backgroundColor: order.status === status
                          ? getStatusColor(status)
                          : '#f0f0f0',
                        color: order.status === status ? '#fff' : '#333',
                      }}
                      onClick={() => updateStatus(order.id, status)}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>

            </div>
          ))}
        </div>
      )}

    </div>
  )
}

const styles = {
  container: {
    fontFamily: 'Arial, sans-serif',
    maxWidth: '960px',
    margin: '0 auto',
    padding: '20px',
    backgroundColor: '#f5f5f5',
    minHeight: '100vh',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: '16px 20px',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    marginBottom: '20px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  title: {
    margin: 0,
    fontSize: '24px',
    color: '#333',
  },
  ownerName: {
    fontSize: '14px',
    color: '#555',
    fontWeight: 'bold',
  },
  refreshBtn: {
    padding: '8px 16px',
    backgroundColor: '#4CAF50',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  logoutBtn: {
    padding: '8px 16px',
    backgroundColor: '#F44336',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  statsBar: {
    display: 'flex',
    gap: '12px',
    marginBottom: '20px',
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    padding: '16px',
    borderRadius: '12px',
    textAlign: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  statNumber: {
    fontSize: '26px',
    fontWeight: 'bold',
  },
  statLabel: {
    fontSize: '12px',
    color: '#999',
  },
  ordersList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  orderCard: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '20px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  orderHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '12px',
  },
  orderId: {
    margin: 0,
    fontSize: '13px',
    color: '#999',
    fontFamily: 'monospace',
  },
  orderDate: {
    margin: '4px 0 0',
    fontSize: '13px',
    color: '#999',
  },
  statusBadge: {
    padding: '4px 12px',
    borderRadius: '20px',
    color: '#fff',
    fontSize: '12px',
    fontWeight: 'bold',
  },
  customerDetails: {
    borderTop: '1px solid #f0f0f0',
    borderBottom: '1px solid #f0f0f0',
    padding: '12px 0',
    marginBottom: '12px',
    lineHeight: '1.8',
  },
  itemsBox: {
    backgroundColor: '#f9f9f9',
    borderRadius: '8px',
    padding: '12px',
    marginBottom: '12px',
  },
  itemsTitle: {
    margin: '0 0 8px',
    fontWeight: 'bold',
    fontSize: '14px',
  },
  itemRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 0',
    fontSize: '14px',
    borderBottom: '1px solid #eee',
    gap: '8px',
  },
  itemQty: {
    color: '#666',
  },
  statusButtons: {
    marginTop: '8px',
  },
  updateLabel: {
    margin: '0 0 8px',
    fontSize: '13px',
    color: '#666',
  },
  btnRow: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
  },
  statusBtn: {
    padding: '6px 12px',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 'bold',
    textTransform: 'capitalize',
  },
  center: {
    textAlign: 'center',
    padding: '60px',
  },
  loadingText: {
    fontSize: '18px',
    color: '#999',
  },
  emptyText: {
    fontSize: '20px',
    color: '#666',
  },
  emptySubText: {
    fontSize: '14px',
    color: '#999',
  },
  errorBox: {
    backgroundColor: '#ffebee',
    border: '1px solid #ffcdd2',
    borderRadius: '8px',
    padding: '16px',
    textAlign: 'center',
    color: '#c62828',
  },
  retryBtn: {
    padding: '8px 16px',
    backgroundColor: '#F44336',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    marginTop: '8px',
  },
}

export default App