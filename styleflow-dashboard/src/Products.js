import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

function Products({ owner }) {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [editProduct, setEditProduct] = useState(null)
  const [form, setForm] = useState({
    product_name: '',
    price: '',
    stock: '',
    size: '',
    color: '',
    category: '',
    image_url: ''
  })

  useEffect(() => {
    fetchProducts()
  }, [])

  // ✅ Fetch products for this store only
  async function fetchProducts() {
    try {
      setLoading(true)
      setError(null)

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('store_id', owner.id)
        .order('id', { ascending: false })

      if (error) {
        console.error('❌ Error fetching products:', error.message)
        setError(error.message)
        return
      }

      console.log('✅ Products fetched:', data.length)
      setProducts(data)

    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ✅ Handle form input change
  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  // ✅ Open add form
  function handleAddClick() {
    setEditProduct(null)
    setForm({
      product_name: '',
      price: '',
      stock: '',
      size: '',
      color: '',
      category: '',
      image_url: ''
    })
    setShowForm(true)
  }

  // ✅ Open edit form
  function handleEditClick(product) {
    setEditProduct(product)
    setForm({
      product_name: product.product_name,
      price: product.price,
      stock: product.stock,
      size: product.size,
      color: product.color,
      category: product.category,
      image_url: product.image_url || ''
    })
    setShowForm(true)
  }

  // ✅ Save product (add or edit)
  async function handleSave() {
    try {
      if (!form.product_name || !form.price || !form.stock) {
        alert('Please fill Name, Price and Stock')
        return
      }

      const productData = {
        product_name: form.product_name,
        price: Number(form.price),
        stock: Number(form.stock),
        size: form.size,
        color: form.color,
        category: form.category,
        image_url: form.image_url,
        store_id: owner.id  // ✅ always link to current store
      }

      if (editProduct) {
        // ✅ Update existing product
        const { error } = await supabase
          .from('products')
          .update(productData)
          .eq('id', editProduct.id)

        if (error) {
          console.error('❌ Update error:', error.message)
          alert('Could not update product. Try again!')
          return
        }

        console.log('✅ Product updated:', form.product_name)

      } else {
        // ✅ Insert new product
        const { error } = await supabase
          .from('products')
          .insert(productData)

        if (error) {
          console.error('❌ Insert error:', error.message)
          alert('Could not add product. Try again!')
          return
        }

        console.log('✅ Product added:', form.product_name)
      }

      setShowForm(false)
      fetchProducts()

    } catch (err) {
      console.error('❌ Save error:', err.message)
    }
  }

  // ✅ Delete product
  async function handleDelete(productId, productName) {
    if (!window.confirm(`Delete "${productName}"?`)) return

    const { error } = await supabase
      .from('products')
      .delete()
      .eq('id', productId)

    if (error) {
      console.error('❌ Delete error:', error.message)
      alert('Could not delete product. Try again!')
      return
    }

    console.log('✅ Product deleted:', productId)
    fetchProducts()
  }

  return (
    <div style={styles.container}>

      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>📦 Products</h2>
        <button style={styles.addBtn} onClick={handleAddClick}>
          ➕ Add Product
        </button>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <div style={styles.formBox}>
          <h3 style={styles.formTitle}>
            {editProduct ? '✏️ Edit Product' : '➕ Add New Product'}
          </h3>

          <div style={styles.formGrid}>
            {[
              { label: 'Product Name *', name: 'product_name', type: 'text',   placeholder: 'e.g. Black Hoodie' },
              { label: 'Price (₹) *',    name: 'price',        type: 'number', placeholder: 'e.g. 999' },
              { label: 'Stock *',        name: 'stock',        type: 'number', placeholder: 'e.g. 50' },
              { label: 'Size',           name: 'size',         type: 'text',   placeholder: 'e.g. M, L, XL' },
              { label: 'Color',          name: 'color',        type: 'text',   placeholder: 'e.g. Black' },
              { label: 'Category',       name: 'category',     type: 'text',   placeholder: 'e.g. T-Shirts' },
              { label: 'Image URL',      name: 'image_url',    type: 'text',   placeholder: 'https://...' },
            ].map((field) => (
              <div key={field.name} style={styles.formField}>
                <label style={styles.label}>{field.label}</label>
                <input
                  style={styles.input}
                  type={field.type}
                  name={field.name}
                  placeholder={field.placeholder}
                  value={form[field.name]}
                  onChange={handleChange}
                />
              </div>
            ))}
          </div>

          <div style={styles.formActions}>
            <button style={styles.saveBtn} onClick={handleSave}>
              {editProduct ? '✅ Update Product' : '✅ Save Product'}
            </button>
            <button style={styles.cancelBtn} onClick={() => setShowForm(false)}>
              ❌ Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={styles.center}>
          <p style={styles.loadingText}>⏳ Loading products...</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={styles.errorBox}>
          <p>❌ Error: {error}</p>
          <button style={styles.retryBtn} onClick={fetchProducts}>Retry</button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && products.length === 0 && (
        <div style={styles.center}>
          <p style={styles.emptyText}>📭 No products yet.</p>
          <p style={styles.emptySubText}>Click "Add Product" to add your first product.</p>
        </div>
      )}

      {/* Products Table */}
      {!loading && !error && products.length > 0 && (
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.tableHeaderRow}>
                <th style={styles.th}>📦 Name</th>
                <th style={styles.th}>💰 Price</th>
                <th style={styles.th}>📊 Stock</th>
                <th style={styles.th}>📐 Size</th>
                <th style={styles.th}>🎨 Color</th>
                <th style={styles.th}>🏷️ Category</th>
                <th style={styles.th}>🖼️ Image</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} style={styles.tableRow}>
                  <td style={styles.td}><strong>{product.product_name}</strong></td>
                  <td style={styles.td}>₹{product.price}</td>
                  <td style={styles.td}>
                    <span style={{
                      ...styles.stockBadge,
                      backgroundColor: product.stock > 10 ? '#e8f5e9' : '#ffebee',
                      color: product.stock > 10 ? '#2e7d32' : '#c62828'
                    }}>
                      {product.stock}
                    </span>
                  </td>
                  <td style={styles.td}>{product.size || '-'}</td>
                  <td style={styles.td}>{product.color || '-'}</td>
                  <td style={styles.td}>{product.category || '-'}</td>
                  <td style={styles.td}>
                    {product.image_url
                      ? <img src={product.image_url} alt={product.product_name} style={styles.productImage} />
                      : <span style={styles.noImage}>No image</span>
                    }
                  </td>
                  <td style={styles.td}>
                    <div style={styles.actionBtns}>
                      <button
                        style={styles.editBtn}
                        onClick={() => handleEditClick(product)}
                      >
                        ✏️ Edit
                      </button>
                      <button
                        style={styles.deleteBtn}
                        onClick={() => handleDelete(product.id, product.product_name)}
                      >
                        🗑️ Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  )
}

const styles = {
  container: {
    fontFamily: 'Arial, sans-serif',
    padding: '20px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
    backgroundColor: '#fff',
    padding: '16px 20px',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  title: {
    margin: 0,
    fontSize: '22px',
    color: '#333',
  },
  addBtn: {
    padding: '10px 20px',
    backgroundColor: '#4CAF50',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 'bold',
  },
  formBox: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '24px',
    marginBottom: '20px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
  formTitle: {
    margin: '0 0 20px',
    fontSize: '18px',
    color: '#333',
  },
  formGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '16px',
  },
  formField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '13px',
    color: '#555',
    fontWeight: 'bold',
  },
  input: {
    padding: '10px 14px',
    borderRadius: '8px',
    border: '1px solid #ddd',
    fontSize: '14px',
    outline: 'none',
    backgroundColor: '#fafafa',
  },
  formActions: {
    display: 'flex',
    gap: '12px',
    marginTop: '20px',
  },
  saveBtn: {
    padding: '10px 24px',
    backgroundColor: '#4CAF50',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 'bold',
  },
  cancelBtn: {
    padding: '10px 24px',
    backgroundColor: '#f0f0f0',
    color: '#333',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  tableWrapper: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  tableHeaderRow: {
    backgroundColor: '#f5f5f5',
  },
  th: {
    padding: '12px 16px',
    textAlign: 'left',
    fontSize: '13px',
    color: '#666',
    fontWeight: 'bold',
    borderBottom: '1px solid #eee',
  },
  tableRow: {
    borderBottom: '1px solid #f0f0f0',
  },
  td: {
    padding: '12px 16px',
    fontSize: '14px',
    color: '#333',
    verticalAlign: 'middle',
  },
  stockBadge: {
    padding: '4px 10px',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: 'bold',
  },
  productImage: {
    width: '50px',
    height: '50px',
    objectFit: 'cover',
    borderRadius: '6px',
  },
  noImage: {
    color: '#999',
    fontSize: '12px',
  },
  actionBtns: {
    display: 'flex',
    gap: '8px',
  },
  editBtn: {
    padding: '6px 12px',
    backgroundColor: '#2196F3',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  deleteBtn: {
    padding: '6px 12px',
    backgroundColor: '#F44336',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
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
    marginBottom: '16px',
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

export default Products