import { useState, useEffect } from 'react'
import { supabase } from './supabase.js'

function TrialAnalytics({ owner }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [metrics, setMetrics] = useState(null)
  const [checklist, setChecklist] = useState({
    productsSetup: false,
    trainingCompleted: false,
    demoOrderCompleted: false,
    customersIntroduced: false
  })
  const [savingChecklist, setSavingChecklist] = useState(false)

  useEffect(() => {
    if (owner?.id) fetchAnalytics(owner.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner?.id])

  const fetchAnalytics = async (storeId) => {
    try {
      setLoading(true)
      setError(null)

      // Trial dates come only from shop_owners — never invented here.
      const { data: ownerRow, error: ownerError } = await supabase
        .from('shop_owners')
        .select('trial_start_date, trial_end_date, training_completed, customers_introduced')
        .eq('id', storeId)
        .maybeSingle()

      if (ownerError) {
        setError(ownerError.message)
        setLoading(false)
        return
      }

      const trialStart = ownerRow?.trial_start_date || null
      const trialEnd = ownerRow?.trial_end_date || null

      // All analytics queries are scoped by store_id and, where a trial
      // window exists, further scoped by the trial's own start/end dates.
      const windowStart = trialStart
      const windowEnd = trialEnd

      const scopedCount = async (table, timestampCol, extraFilters) => {
        let query = supabase
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq('store_id', storeId)
        if (windowStart) query = query.gte(timestampCol, windowStart)
        if (windowEnd) query = query.lte(timestampCol, windowEnd)
        if (extraFilters) query = extraFilters(query)
        const { count, error: qErr } = await query
        if (qErr) throw qErr
        return count || 0
      }

      const scopedUniquePhones = async (table, timestampCol) => {
        let query = supabase
          .from(table)
          .select('phone_number')
          .eq('store_id', storeId)
        if (windowStart) query = query.gte(timestampCol, windowStart)
        if (windowEnd) query = query.lte(timestampCol, windowEnd)
        const { data, error: qErr } = await query
        if (qErr) throw qErr
        const unique = new Set((data || []).map(r => r.phone_number).filter(Boolean))
        return unique.size
      }

      const [
        productViews,
        cartAdds,
        checkoutStarts,
        ordersCaptured,
        ordersCompleted,
        customersUsing,
        productsCount,
        ordersCount
      ] = await Promise.all([
        scopedCount('product_views', 'viewed_at'),
        scopedCount('cart_events', 'added_at'),
        scopedCount('checkout_events', 'started_at'),
        scopedCount('orders', 'created_at'),
        scopedCount('orders', 'created_at', (q) => q.eq('status', 'delivered')),
        scopedUniquePhones('product_views', 'viewed_at'),
        supabase.from('products').select('*', { count: 'exact', head: true }).eq('store_id', storeId),
        supabase.from('orders').select('*', { count: 'exact', head: true }).eq('store_id', storeId)
      ])

      setMetrics({
        trialStart,
        trialEnd,
        customersUsing,
        productViews,
        cartAdds,
        checkoutStarts,
        ordersCaptured,
        ordersCompleted
      })

      setChecklist({
        productsSetup: (productsCount?.count || 0) > 0,
        trainingCompleted: !!ownerRow?.training_completed,
        demoOrderCompleted: (ordersCount?.count || 0) > 0,
        customersIntroduced: !!ownerRow?.customers_introduced
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const daysRemaining = (() => {
    if (!metrics?.trialEnd) return null
    const end = new Date(metrics.trialEnd)
    const now = new Date()
    const diffMs = end.getTime() - now.getTime()
    return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)))
  })()

  const formatDate = (isoString) => {
    if (!isoString) return '—'
    return new Date(isoString).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric'
    })
  }

  const toggleManualItem = async (field) => {
    if (!owner?.id) return
    try {
      setSavingChecklist(true)
      const newValue = !checklist[field === 'trainingCompleted' ? 'trainingCompleted' : 'customersIntroduced']
      const column = field === 'trainingCompleted' ? 'training_completed' : 'customers_introduced'

      const { error: updateError } = await supabase
        .from('shop_owners')
        .update({ [column]: newValue })
        .eq('id', owner.id)

      if (updateError) {
        setError(updateError.message)
        return
      }

      setChecklist(prev => ({ ...prev, [field]: newValue }))
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingChecklist(false)
    }
  }

  if (loading) {
    return (
      <div style={styles.center}>
        <p style={styles.loadingText}>⏳ Loading trial analytics...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={styles.errorBox}>
        <p>❌ Error: {error}</p>
        <button style={styles.retryBtn} onClick={() => fetchAnalytics(owner.id)}>
          Retry
        </button>
      </div>
    )
  }

  if (!metrics?.trialStart || !metrics?.trialEnd) {
    return (
      <div style={styles.center}>
        <p style={styles.emptyText}>📅 Trial dates haven't been set up for this store yet.</p>
        <p style={styles.emptySubText}>Contact StyleFlow support to get your trial started.</p>
      </div>
    )
  }

  const usageStats = [
    { label: '👥 Customers Using StyleFlow', value: metrics.customersUsing },
    { label: '👀 Products Viewed', value: metrics.productViews },
    { label: '🛒 Added to Cart', value: metrics.cartAdds },
    { label: '✅ Checkout Started', value: metrics.checkoutStarts },
    { label: '📦 Orders Captured', value: metrics.ordersCaptured },
    { label: '🎉 Orders Completed', value: metrics.ordersCompleted }
  ]

  const checklistItems = [
    { key: 'productsSetup', label: 'Products Setup', manual: false },
    { key: 'trainingCompleted', label: 'Owner/Staff Training', manual: true },
    { key: 'demoOrderCompleted', label: 'Demo Order Completed', manual: false },
    { key: 'customersIntroduced', label: 'Customers Introduced to StyleFlow', manual: true }
  ]

  return (
    <div>
      <div style={styles.trialCard}>
        <h3 style={styles.sectionTitle}>📅 Your 14-Day Trial</h3>
        <div style={styles.trialRow}>
          <div style={styles.trialItem}>
            <span style={styles.trialLabel}>Trial Start</span>
            <span style={styles.trialValue}>{formatDate(metrics.trialStart)}</span>
          </div>
          <div style={styles.trialItem}>
            <span style={styles.trialLabel}>Trial End</span>
            <span style={styles.trialValue}>{formatDate(metrics.trialEnd)}</span>
          </div>
          <div style={styles.trialItem}>
            <span style={styles.trialLabel}>Days Remaining</span>
            <span style={{
              ...styles.trialValue,
              color: daysRemaining !== null && daysRemaining <= 3 ? '#e53935' : '#2e7d32',
              fontWeight: 'bold'
            }}>
              {daysRemaining !== null ? `${daysRemaining} days` : '—'}
            </span>
          </div>
        </div>
      </div>

      <h3 style={styles.sectionTitle}>📊 Is StyleFlow Being Used?</h3>
      <div style={styles.statsGrid}>
        {usageStats.map(stat => (
          <div key={stat.label} style={styles.statCard}>
            <span style={styles.statNumber}>{stat.value}</span>
            <span style={styles.statLabel}>{stat.label}</span>
          </div>
        ))}
      </div>

      <h3 style={styles.sectionTitle}>✅ Onboarding Checklist</h3>
      <div style={styles.checklistBox}>
        {checklistItems.map(item => (
          <div key={item.key} style={styles.checklistRow}>
            <span style={styles.checklistLabel}>
              {checklist[item.key] ? '☑️' : '☐'} {item.label}
            </span>
            {item.manual && (
              <button
                style={styles.checklistToggleBtn}
                disabled={savingChecklist}
                onClick={() => toggleManualItem(item.key)}
              >
                {checklist[item.key] ? 'Mark Incomplete' : 'Mark Complete'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const styles = {
  center: {
    textAlign: 'center',
    padding: '40px 20px'
  },
  loadingText: {
    fontSize: '16px',
    color: '#666'
  },
  emptyText: {
    fontSize: '16px',
    color: '#333',
    fontWeight: 'bold'
  },
  emptySubText: {
    fontSize: '14px',
    color: '#888',
    marginTop: '8px'
  },
  errorBox: {
    backgroundColor: '#ffebee',
    color: '#c62828',
    padding: '16px',
    borderRadius: '8px',
    margin: '16px 0'
  },
  retryBtn: {
    marginTop: '8px',
    padding: '8px 16px',
    backgroundColor: '#c62828',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer'
  },
  sectionTitle: {
    fontSize: '18px',
    fontWeight: 'bold',
    margin: '20px 0 12px 0',
    color: '#333'
  },
  trialCard: {
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '10px',
    padding: '16px'
  },
  trialRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '16px',
    marginTop: '8px'
  },
  trialItem: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: '120px'
  },
  trialLabel: {
    fontSize: '12px',
    color: '#888',
    marginBottom: '4px'
  },
  trialValue: {
    fontSize: '16px',
    color: '#333'
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px'
  },
  statCard: {
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '10px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center'
  },
  statNumber: {
    fontSize: '24px',
    fontWeight: 'bold',
    color: '#4CAF50'
  },
  statLabel: {
    fontSize: '13px',
    color: '#666',
    marginTop: '4px'
  },
  checklistBox: {
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '10px',
    padding: '8px 16px'
  },
  checklistRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 0',
    borderBottom: '1px solid #f0f0f0'
  },
  checklistLabel: {
    fontSize: '14px',
    color: '#333'
  },
  checklistToggleBtn: {
    padding: '6px 12px',
    fontSize: '12px',
    backgroundColor: '#f0f0f0',
    border: '1px solid #ccc',
    borderRadius: '6px',
    cursor: 'pointer'
  }
}

export default TrialAnalytics