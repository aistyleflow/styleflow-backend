const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const messages = require("./helpers/messageTemplates");
const { understandVoiceOrder } = require("./voiceAI");
const { matchProductFromVoiceRequest } = require("./productMatcher");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─────────────────────────────────────────────────────────
// META WHATSAPP CLOUD API CONFIG
// ─────────────────────────────────────────────────────────
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_GRAPH_VERSION = "v20.0";
const META_GRAPH_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`;

// ─────────────────────────────────────────────────────────
// VOICE ORDERING — PHASE 1 CONFIG
// Read from env only. Never log the value.
// Full Gemini/AI understanding pipeline arrives in Phase 2.
// ─────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const META_MEDIA_BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

// ─────────────────────────────────────────────────────────
// RAZORPAY — PHASE 2 CONFIG
// Order creation only. No verification/webhook logic yet.
// ─────────────────────────────────────────────────────────
const Razorpay = require("razorpay");
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const GREETINGS = ["hi", "hello", "hey", "helo", "hii", "start", "namaste"];

function formatDate(dateString) {
  if (!dateString) return 'N/A'
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return 'N/A'
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata'
  })
}

function formatDateOnly(dateString) {
  if (!dateString) return 'N/A'
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return 'N/A'
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata'
  })
}

function getStatusEmoji(status) {
  switch (status) {
    case 'pending':   return '⏳'
    case 'confirmed': return '✅'
    case 'shipped':   return '🚚'
    case 'delivered': return '📦'
    case 'cancelled': return '❌'
    default:          return '📋'
  }
}

async function getShopName(storeId) {
  if (!storeId) return "StyleFlow";
  const { data: store } = await supabase
    .from("shop_owners")
    .select("shop_name")
    .eq("id", storeId)
    .maybeSingle();
  return store?.shop_name || "StyleFlow";
}

async function getStoreIdForCustomer(phone) {
  const { data: lastOrder } = await supabase
    .from("orders")
    .select("store_id")
    .eq("phone_number", phone)
    .not("store_id", "is", null)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  return lastOrder?.store_id || null;
}

async function getStoreByCode(code) {
  if (!code) return null;
  const { data } = await supabase
    .from("shop_owners")
    .select("id, shop_name, store_code")
    .eq("store_code", code.toUpperCase().trim())
    .maybeSingle();
  return data || null;
}

async function saveStoreToSession(phone, storeId) {
  try {
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("user_sessions")
        .update({ store_id: storeId })
        .eq("phone_number", phone);
    } else {
      await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, store_id: storeId });
    }
  } catch (err) {
    console.error("❌ saveStoreToSession error:", err.message);
  }
}

async function incrementStoreMessageUsage(storeId, direction) {
  if (!storeId) return;
  try {
    const now = new Date().toISOString();
    const { data: existing } = await supabase
      .from("store_message_usage")
      .select("*")
      .eq("store_id", storeId)
      .maybeSingle();

    if (existing) {
      const updates = {
        total_count: (existing.total_count || 0) + 1,
        last_message_at: now,
        updated_at: now
      };
      if (direction === "incoming") updates.incoming_count = (existing.incoming_count || 0) + 1;
      else if (direction === "outgoing") updates.outgoing_count = (existing.outgoing_count || 0) + 1;
      await supabase.from("store_message_usage").update(updates).eq("store_id", storeId);
    } else {
      await supabase.from("store_message_usage").insert({
        store_id: storeId,
        incoming_count: direction === "incoming" ? 1 : 0,
        outgoing_count: direction === "outgoing" ? 1 : 0,
        total_count: 1,
        last_message_at: now,
        updated_at: now
      });
    }
  } catch (err) {
    console.error("❌ incrementStoreMessageUsage error:", err.message);
  }
}

async function getPaymentSettings(storeId) {
  if (!storeId) return null;
  const { data, error } = await supabase
    .from("store_payment_settings")
    .select("cod_enabled, upi_enabled, upi_id, qr_code_url, minimum_cod_amount, default_payment, payment_instructions")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) {
    console.error("❌ getPaymentSettings error:", error.message);
    return null;
  }
  return data || null;
}

async function getSavedAddress(phone, storeId) {
  if (!phone || !storeId) return null;
  const { data } = await supabase
    .from("customer_addresses")
    .select("*")
    .eq("phone_number", phone)
    .eq("store_id", storeId)
    .maybeSingle();
  return data;
}

async function saveCustomerAddress(phone, storeId, customerName, address, pincode) {
  try {
    const existing = await getSavedAddress(phone, storeId);
    const resolvedPincode = pincode || (address.match(/\d{6}/) || [])[0] || null;

    if (existing) {
      await supabase
        .from("customer_addresses")
        .update({
          customer_name: customerName,
          address: address,
          pincode: resolvedPincode,
          updated_at: new Date().toISOString()
        })
        .eq("phone_number", phone)
        .eq("store_id", storeId);
    } else {
      await supabase
        .from("customer_addresses")
        .insert({
          phone_number: phone,
          store_id: storeId,
          customer_name: customerName,
          address: address,
          pincode: resolvedPincode,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
    }
  } catch (err) {
    console.error("❌ saveCustomerAddress error:", err.message);
  }
}

async function getOrderItems(orderId) {
  try {
    const { data: orderItems } = await supabase
      .from('order_items')
      .select('quantity, product_id, product_name, price, size')
      .eq('order_id', orderId)

    if (!orderItems || orderItems.length === 0) return '   No items found'

    let itemsText = ''
    let total = 0

    for (const item of orderItems) {
      let productName = item.product_name || null;
      let productPrice = item.price || null;

      if (!productName || !productPrice) {
        const { data: product } = await supabase
          .from('products')
          .select('product_name, price')
          .eq('id', item.product_id)
          .maybeSingle();
        productName = productName || product?.product_name || 'Unknown Product';
        productPrice = productPrice || product?.price || 0;
      }

      const itemTotal = productPrice * item.quantity;
      total += itemTotal;
      const sizeText = item.size && item.size !== 'Free Size' ? ` (${item.size})` : '';
      itemsText += `   • ${productName}${sizeText} × ${item.quantity} = ₹${itemTotal}\n`;
    }

    itemsText += `   💰 Total: ₹${total}`
    return itemsText

  } catch (err) {
    console.error("❌ getOrderItems error:", err.message)
    return '   Error fetching items'
  }
}

function isInActiveOrderFlow(session) {
  if (!session) return false;
  const activeSteps = [
    "name_phone", "address_pincode",
    "payment", "awaiting_payment",
    "saved_address_choice", "size",
    "coupon",
    "name", "address", "pincode"
  ];
  return activeSteps.includes(session.checkout_step);
}

async function clearOrderSession(phone) {
  try {
    await supabase.from("cart").delete().eq("phone_number", phone);
    await supabase
      .from("user_sessions")
      .update({
        checkout_step: null,
        action_step: null,
        customer_name: null,
        customer_phone: null,
        customer_address: null,
        selected_product_id: null,
        pending_store_id: null,
        pending_order_total: null,
        payment_method: null,
        saved_address_data: null,
        applied_coupon_code: null,
        applied_discount_amount: null
      })
      .eq("phone_number", phone);
    console.log("✅ Order session cleared for:", phone);
  } catch (err) {
    console.error("❌ clearOrderSession error:", err.message);
  }
}

async function getLastPlacedOrder(phone, storeId) {
  try {
    let query = supabase
      .from("orders")
      .select("*")
      .eq("phone_number", phone)
      .order("id", { ascending: false })
      .limit(1);
    if (storeId) query = query.eq("store_id", storeId);
    const { data: orders } = await query;
    return orders && orders.length > 0 ? orders[0] : null;
  } catch (err) {
    return null;
  }
}

async function getStorePhone(storeId) {
  if (!storeId) return null;
  try {
    const { data } = await supabase
      .from("shop_owners")
      .select("phone_number, shop_name")
      .eq("id", storeId)
      .maybeSingle();
    return data || null;
  } catch (err) {
    return null;
  }
}

async function validateCoupon(couponCode, storeId, orderTotal) {
  try {
    const { data: offer, error } = await supabase
      .from("offers")
      .select("*")
      .eq("store_id", storeId)
      .eq("coupon_code", couponCode.trim())
      .maybeSingle();

    if (error || !offer) {
      return { valid: false, reason: "invalid" };
    }

    if (offer.start_date) {
      const startDate = new Date(offer.start_date);
      if (new Date() < startDate) {
        return {
          valid: false,
          reason: "not_started",
          offer,
          startDateFormatted: formatDateOnly(offer.start_date)
        };
      }
    }

    if (offer.end_date) {
      const endDate = new Date(offer.end_date);
      endDate.setHours(23, 59, 59, 999);
      if (new Date() > endDate) {
        return {
          valid: false,
          reason: "expired",
          offer,
          endDateFormatted: formatDateOnly(offer.end_date)
        };
      }
    }

    const minOrder = offer.minimum_order_amount || 0;
    if (minOrder > 0 && orderTotal < minOrder) {
      return { valid: false, reason: "min_order", offer, minOrder };
    }

    let discountAmount = 0;
    if (offer.discount_type === "percentage") {
      discountAmount = Math.round((orderTotal * (offer.discount_value || 0)) / 100);
    } else if (offer.discount_type === "fixed") {
      discountAmount = offer.discount_value || 0;
    }

    discountAmount = Math.min(discountAmount, orderTotal);
    const finalTotal = orderTotal - discountAmount;

    return {
      valid: true,
      offer,
      discountAmount,
      finalTotal,
      discountType: offer.discount_type,
      discountValue: offer.discount_value
    };

  } catch (err) {
    console.error("❌ validateCoupon error:", err.message);
    return { valid: false, reason: "error" };
  }
}

// ─────────────────────────────────────────────────────────
// createRazorpayOrder — Phase 2: creates a Razorpay Order for the
// customer's current UPI payment attempt and stores its ID in
// user_sessions.razorpay_order_id. Does NOT create a StyleFlow order
// row and does NOT mark any payment as successful — placeOrder()
// remains the only place a real order/payment_status is written.
// Returns { success, razorpayOrderId } or { success: false, error }.
// ─────────────────────────────────────────────────────────
async function createRazorpayOrder(phone, session, orderTotal) {
  try {
    // Reuse an existing pending Razorpay order for this session instead
    // of creating a duplicate one.
    if (session?.razorpay_order_id) {
      return { success: true, razorpayOrderId: session.razorpay_order_id, reused: true };
    }

    const amountInPaise = Math.round(Number(orderTotal) * 100);

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `styleflow_${phone}_${Date.now()}`
    });

    if (!razorpayOrder || !razorpayOrder.id) {
      console.error("❌ createRazorpayOrder: no order id returned by Razorpay");
      return { success: false, error: "no_order_id_returned" };
    }

    const { error: updateError } = await supabase
      .from("user_sessions")
      .update({ razorpay_order_id: razorpayOrder.id })
      .eq("phone_number", phone);

    if (updateError) {
      console.error("❌ createRazorpayOrder: failed to save razorpay_order_id to session:", updateError.message);
      return { success: false, error: "session_save_failed" };
    }

    console.log("✅ Razorpay order created:", razorpayOrder.id, "amount(paise):", amountInPaise);
    return { success: true, razorpayOrderId: razorpayOrder.id, reused: false };

  } catch (err) {
    console.error("❌ createRazorpayOrder error:", err.message);
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────
// createPendingOnlineOrder — Online Payment flow only.
// Creates the real StyleFlow `orders` row BEFORE the Razorpay
// Payment Link exists, so the future webhook can look the order
// up by id. payment_status is always "pending" here — this
// function never marks anything paid/confirmed. Mirrors the same
// fields placeOrder() writes so nothing downstream (dashboard,
// getOrderItems, /update-status, etc.) breaks.
// Returns { success, order } or { success: false, error }.
// ─────────────────────────────────────────────────────────
async function createPendingOnlineOrder(phone, session, storeId, orderTotal, shopName) {
  try {
    const { data: cartItems } = await supabase
      .from("cart").select("*").eq("phone_number", phone);

    if (!cartItems || cartItems.length === 0) {
      return { success: false, error: "empty_cart" };
    }

    let storeOrderNumber = 1;
    if (storeId) {
      const { count } = await supabase
        .from("orders")
        .select("*", { count: "exact", head: true })
        .eq("store_id", storeId);
      storeOrderNumber = (count || 0) + 1;
    }

    const addressStr = session.customer_address || '';
    const pincodeFromAddress = (addressStr.match(/\b(\d{6})\b/) || [])[1] || null;

    const orderInsertData = {
      phone_number: phone,
      customer_name: session.customer_name,
      customer_phone: session.customer_phone || null,
      customer_address: session.customer_address,
      status: "pending",
      store_id: storeId,
      store_order_number: storeOrderNumber,
      payment_method: "UPI",
      payment_status: "pending",
      payment_amount: orderTotal,
      coupon_code: session.applied_coupon_code || null,
      discount_amount: session.applied_discount_amount || 0,
      razorpay_order_id: null,
      razorpay_payment_link_id: null,
      created_at: new Date().toISOString()
    };

    let order = null;
    let orderError = null;

    const { data: orderWithPincode, error: errorWithPincode } = await supabase
      .from("orders")
      .insert({ ...orderInsertData, customer_pincode: pincodeFromAddress })
      .select()
      .single();

    if (errorWithPincode) {
      console.log("⚠️ customer_pincode column missing in orders — inserting without it");
      const { data: orderWithout, error: errorWithout } = await supabase
        .from("orders")
        .insert(orderInsertData)
        .select()
        .single();
      order = orderWithout;
      orderError = errorWithout;
    } else {
      order = orderWithPincode;
      orderError = null;
    }

    if (orderError || !order) {
      console.error("❌ createPendingOnlineOrder: order insert error:", orderError?.message);
      return { success: false, error: "order_insert_failed" };
    }

    const orderItemsToInsert = [];
    for (const item of cartItems) {
      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", item.product_id).maybeSingle();

      if (product) {
        orderItemsToInsert.push({
          order_id: order.id,
          product_id: item.product_id,
          quantity: item.quantity,
          size: item.size || null,
          product_name: product.product_name,
          price: product.price
        });
      }
    }

    if (orderItemsToInsert.length > 0) {
      const { error: itemsError } = await supabase.from('order_items').insert(orderItemsToInsert);
      if (itemsError) {
        console.error("❌ createPendingOnlineOrder: order_items insert error:", itemsError.message);
      }
    }

    console.log("✅ Pending online-payment order created:", order.id, "store_order_number:", storeOrderNumber);
    return { success: true, order };

  } catch (err) {
    console.error("❌ createPendingOnlineOrder error:", err.message);
    return { success: false, error: err.message };
  }
}

app.get("/", (req, res) => {
  res.send("StyleFlow is running!");
});

// ─────────────────────────────────────────────────────────
// META WHATSAPP CLOUD API — MESSAGE SENDING HELPERS
// ─────────────────────────────────────────────────────────

async function isImageAccessible(url) {
  try {
    if (!url || url.trim() === '') return false;
    const response = await fetch(url, { method: "HEAD" });
    console.log(`🔎 Image check: ${url} → ${response.status} ${response.ok ? '✅' : '❌'}`);
    return response.ok;
  } catch (err) {
    console.error("❌ Image accessibility check failed:", err.message);
    return false;
  }
}

// Normalizes a phone value coming from either Meta ("91xxxxxxxxxx")
// or older stored data (possibly prefixed "whatsapp:+91xxxxxxxxxx")
// into the raw MSISDN Meta expects in the "to" field.
function toMetaPhone(phone) {
  if (!phone) return "";

  let clean = phone.toString().trim();

  // Remove "whatsapp:" if present
  clean = clean.replace(/^whatsapp:/, "");

  // Remove spaces, hyphens and brackets
  clean = clean.replace(/[\s\-()]/g, "");

  // Remove leading +
  clean = clean.replace(/^\+/, "");

  // If it's a 10-digit Indian number, add country code
  if (clean.length === 10) {
    clean = "91" + clean;
  }

  return clean;
}

async function metaGraphRequest(payload) {
  try {
    const response = await fetch(META_GRAPH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${META_ACCESS_TOKEN}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("❌ Meta API error:", response.status, JSON.stringify(data));
      return { success: false, status: response.status, data };
    }

    console.log("✅ Meta message sent — id:", data?.messages?.[0]?.id);
    return { success: true, status: response.status, data };
  } catch (err) {
    console.error("❌ Meta API request failed:", err.message);
    return { success: false, error: err.message };
  }
}
async function sendWhatsAppMessage   

  (to, messageBody) {
    const payload = {
    messaging_product: "whatsapp",
    to: toMetaPhone(to),
    type: "text",
    text: { body: messageBody, preview_url: false }
  };

  console.log("📤 Outgoing Meta text request → to:", toMetaPhone(to));
  const result = await metaGraphRequest(payload);
  return result.success;
}

async function sendWhatsAppImageMessage(to, imageUrl, caption) {
  const payload = {
    messaging_product: "whatsapp",
    to: toMetaPhone(to),
    type: "image",
    image: {
      link: imageUrl,
      caption: caption || ""
    }
  };

  console.log("📤 Outgoing Meta image request → to:", toMetaPhone(to), "url:", imageUrl);
  const result = await metaGraphRequest(payload);

  if (!result.success) {
    console.error("❌ Media send failed, falling back to text:", JSON.stringify(result.data || result.error));
  }

  return result.success;
}

// sendWhatsAppImage — thin wrapper matching the signature used by
// handleIncomingAudio()'s matched-product branch: sendWhatsAppImage(phone, imageUrl, caption).
// Reuses the existing sendWhatsAppImageMessage implementation (same Meta
// Phone Number ID, access token, Graph API version, and metaGraphRequest
// error handling already used elsewhere) — no duplicate config, no
// duplicate Graph API call.
async function sendWhatsAppImage(phone, imageUrl, caption = "") {
  const sent = await sendWhatsAppImageMessage(phone, imageUrl, caption);
  if (!sent) {
    throw new Error(`sendWhatsAppImage: Meta rejected image message to ${toMetaPhone(phone)}`);
  }
  return sent;
}

// ─────────────────────────────────────────────────────────
// WHATSAPP INTERACTIVE MESSAGE HELPERS
// Reuse the existing metaGraphRequest() and toMetaPhone() —
// same Phone Number ID, same access token, same error handling.
// No second Meta API client, no duplicate auth logic.
// ─────────────────────────────────────────────────────────

// buttons: array of { id, title } — max 3 per Meta's limit for reply buttons.
async function sendWhatsAppButtons(to, bodyText, buttons, options = {}) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    console.error("❌ sendWhatsAppButtons: no buttons provided");
    return { success: false, error: "no buttons provided" };
  }
  if (buttons.length > 3) {
    console.error("❌ sendWhatsAppButtons: Meta allows max 3 reply buttons, got", buttons.length);
    return { success: false, error: "too many buttons" };
  }

  const payload = {
    messaging_product: "whatsapp",
    to: toMetaPhone(to),
    type: "interactive",
    interactive: {
      type: "button",
      ...(options.header ? { header: { type: "text", text: options.header } } : {}),
      body: { text: bodyText },
      ...(options.footer ? { footer: { text: options.footer } } : {}),
      action: {
        buttons: buttons.map(b => ({
          type: "reply",
          reply: { id: String(b.id), title: String(b.title).slice(0, 20) }
        }))
      }
    }
  };

  console.log("📤 Outgoing Meta interactive-button request → to:", toMetaPhone(to), "ids:", buttons.map(b => b.id).join(","));
  const result = await metaGraphRequest(payload);
  return result.success;
}

// sections: array of { title, rows: [{ id, title, description? }] }
// Meta list limits: up to 10 total rows across all sections.
async function sendWhatsAppList(to, bodyText, buttonText, sections, options = {}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    console.error("❌ sendWhatsAppList: no sections provided");
    return { success: false, error: "no sections provided" };
  }
  const totalRows = sections.reduce((sum, s) => sum + (s.rows?.length || 0), 0);
  if (totalRows === 0) {
    console.error("❌ sendWhatsAppList: no rows provided");
    return { success: false, error: "no rows provided" };
  }
  if (totalRows > 10) {
    console.error("❌ sendWhatsAppList: Meta allows max 10 total rows, got", totalRows);
    return { success: false, error: "too many rows" };
  }

  const payload = {
    messaging_product: "whatsapp",
    to: toMetaPhone(to),
    type: "interactive",
    interactive: {
      type: "list",
      ...(options.header ? { header: { type: "text", text: options.header } } : {}),
      body: { text: bodyText },
      ...(options.footer ? { footer: { text: options.footer } } : {}),
      action: {
        button: buttonText,
        sections: sections.map(s => ({
          title: s.title,
          rows: s.rows.map(r => ({
            id: String(r.id),
            title: String(r.title).slice(0, 24),
            ...(r.description ? { description: String(r.description).slice(0, 72) } : {})
          }))
        }))
      }
    }
  };

  console.log("📤 Outgoing Meta interactive-list request → to:", toMetaPhone(to), "rows:", totalRows);
  const result = await metaGraphRequest(payload);
  return result.success;
}

async function sendProductMessage(phone, product, storeId) {
  console.log("📤 sendProductMessage — product:", product.product_name, "image:", product.image_url || "none");

  const bodyText =
    `🛍️ *Product Details*\n\n` +
    `📦 Product: ${product.product_name}\n` +
    `💰 Price: ₹${product.price}\n` +
    `📦 Stock: ${product.stock}\n` +
    `📐 Sizes: ${product.size || 'Free Size'}\n` +
    `🎨 Color: ${product.color}`;

  const textFallbackBody =
    bodyText + `\n\n─────────────────\n` +
    `Type *ADD* to 🛒 Add to Cart\n` +
    `Type *CART* to 👀 View Cart\n` +
    `Type *CHECKOUT* to ✅ Checkout\n` +
    `🔍 Or search more products`;

  const productButtons = [
    { id: "ADD_PRODUCT", title: "🛒 Add to Cart" },
    { id: "VIEW_CART", title: "👀 View Cart" },
    { id: "CHECKOUT", title: "✅ Checkout" }
  ];

  try {
    // Meta image messages don't support the interactive button structure,
    // so image + caption is sent first, then buttons as a separate message.
    let imageSent = false;
    if (product.image_url && product.image_url.trim() !== '') {
      const accessible = await isImageAccessible(product.image_url);
      if (accessible) {
        console.log("📷 Sending product with image via Meta Cloud API");
        imageSent = await sendWhatsAppImageMessage(phone, product.image_url, product.product_name);
        if (!imageSent) console.log("⚠️ Image send failed — continuing with text/buttons");
      } else {
        console.log("⚠️ Image not accessible — sending text only");
      }
    }

    if (imageSent) {
      if (storeId) await incrementStoreMessageUsage(storeId, "outgoing");
      const buttonsSent = await sendWhatsAppButtons(phone, bodyText, productButtons);
      if (buttonsSent) {
        if (storeId) await incrementStoreMessageUsage(storeId, "outgoing");
      } else {
        console.log("⚠️ Interactive buttons failed after image — falling back to text instructions");
        await sendWhatsAppMessage(phone, `Type *ADD* to 🛒 Add to Cart\nType *CART* to 👀 View Cart\nType *CHECKOUT* to ✅ Checkout`);
        if (storeId) await incrementStoreMessageUsage(storeId, "outgoing");
      }
      return;
    }

    // No image (or image failed) — try interactive buttons with the body text.
    const buttonsSent = await sendWhatsAppButtons(phone, bodyText, productButtons);
    if (buttonsSent) {
      if (storeId) await incrementStoreMessageUsage(storeId, "outgoing");
      return;
    }

    // Final fallback — plain text with typed instructions. Customer must
    // never be left without a response.
    console.log("📝 Sending product text-only via Meta Cloud API (interactive fallback)");
    await sendWhatsAppMessage(phone, textFallbackBody);
    if (storeId) await incrementStoreMessageUsage(storeId, "outgoing");
  } catch (err) {
    console.error("❌ sendProductMessage error:", err.message);
    await sendWhatsAppMessage(phone, textFallbackBody);
    if (storeId) await incrementStoreMessageUsage(storeId, "outgoing");
  }
}

// ─────────────────────────────────────────────────────────
// VOICE ORDERING — PHASE 1 HELPERS
// Phase 1 scope only: safe detection + media ID extraction +
// clean function structure for the Phase 2 AI pipeline.
// No AI calls, no product matching, no order creation here yet.
// Reuses sendWhatsAppMessage (existing) for any customer replies.
// ─────────────────────────────────────────────────────────

// Entry point for an incoming WhatsApp audio/voice message.
// Called from the webhook's message-type branch, parallel to
// the existing text/interactive/button handling — does not
// touch processIncomingMessage or any existing text-order logic.
async function handleIncomingAudio(phone, metaMessage, storeId) {
  try {
    const mediaId = metaMessage?.audio?.id || null;

    if (!mediaId) {
      console.error("❌ Voice message received but no media ID present");
      await sendWhatsAppMessage(
        phone,
        `⚠️ We couldn't process that voice message. Please try again or type your order.`
      );
      return;
    }

    // Never log audio contents — only metadata needed for debugging.
    console.log("🎙️ Audio message received");
    console.log("🆔 Media ID:", mediaId);
    console.log("🎙️ Voice message received — mediaId:", mediaId, "from:", phone);

    // ── PHASE 2: resolve the Meta media URL and download the audio ──
    const audioResult = await downloadMetaMedia(mediaId);

    if (!audioResult || !audioResult.success) {
      console.error("❌ Voice message audio retrieval failed for mediaId:", mediaId);
      await sendWhatsAppMessage(
        phone,
        `⚠️ We couldn't process that voice message. Please try again or type your order.`
      );
      return; // do not continue processing the voice order
    }

    console.log("✅ Audio downloaded successfully");

    // ── PHASE 3: Send downloaded audio to Gemini ──
    const voiceResult = await understandVoiceOrder(
      audioResult.audioBuffer,
      audioResult.mimeType
    );

    console.log("📋 Voice AI result:", voiceResult);

    const productResult = await matchProductFromVoiceRequest(supabase,storeId,voiceResult);

    console.log("🔎 Product matching result:", productResult);

    if (!voiceResult || !voiceResult.understood) {
      await sendWhatsAppMessage(
        phone,
        "Sorry, I couldn't understand your voice message clearly. Please try again."
      );
      return;
    }

    if (!productResult || productResult.status === "error") {
  await sendWhatsAppMessage(
    phone,
    "⚠️ I couldn't check the store catalog right now. Please try again."
  );
  return;
}

if (productResult.status === "not_found") {
  await sendWhatsAppMessage(
    phone,
    `❌ I couldn't find "${voiceResult.product_query}" in this store's catalog.\n\nPlease try another product.`
  );
  return;
}

if (productResult.status === "multiple_matches") {
  // ✅ Persist the pending voice multiple-match state using only EXISTING
  // columns: last_results (JSONB, reused as an object instead of the plain
  // array normal text search stores) + action_step as the discriminator
  // checked before other handlers.
  try {
    const voiceMultiMatchPayload = {
      voice_pending: true,
      type: "multiple_matches",
      matches: productResult.matches.map(p => ({ id: p.id })),
      size: voiceResult.size || null,
      quantity: voiceResult.quantity || 1
    };

    const { data: existingSession, error: sessionFetchError } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    if (sessionFetchError) {
      console.error("❌ Failed to fetch session for voice multiple_matches state:", sessionFetchError.message);
    } else if (existingSession) {
      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({ last_results: voiceMultiMatchPayload, action_step: "voice_multi_pending" })
        .eq("phone_number", phone);
      if (updateError) {
        console.error("❌ Failed to save voice multiple_matches state (update):", updateError.message);
      }
    } else {
      const { error: insertError } = await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, last_results: voiceMultiMatchPayload, action_step: "voice_multi_pending" });
      if (insertError) {
        console.error("❌ Failed to save voice multiple_matches state (insert):", insertError.message);
      }
    }
  } catch (stateErr) {
    console.error("❌ Failed to save voice multiple_matches state:", stateErr.message);
  }

  // ✅ Interactive list as primary UI. Row IDs are VOICE_PRODUCT_<id> so the
  // "8b. VOICE MULTIPLE-MATCH PRODUCT SELECTION" handler (which validates
  // store isolation) resolves them deterministically. Numeric reply ("1",
  // "2", ...) remains a working fallback via the same handler.
  const rows = productResult.matches.slice(0, 10).map(product => ({
    id: `VOICE_PRODUCT_${product.id}`,
    title: product.product_name.slice(0, 24),
    description: [product.color, product.price ? `₹${product.price}` : null].filter(Boolean).join(' · ').slice(0, 72)
  }));

  const listSent = await sendWhatsAppList(
    phone,
    `🔎 I found multiple products matching "${voiceResult.product_query}". Select one:`,
    "View Products",
    [{ title: "Matching Products", rows }]
  );

  if (!listSent) {
    // Fallback: plain numbered text (legacy behavior), still resolvable by
    // the same handler via its numeric-reply path.
    let reply = `🔎 I found multiple products matching "${voiceResult.product_query}":\n\n`;
    productResult.matches.forEach((product, index) => {
      reply += `${index + 1}. *${product.product_name}*`;
      if (product.color) reply += ` — ${product.color}`;
      if (product.price) reply += ` — ₹${product.price}`;
      reply += `\n`;
    });
    reply += `\nPlease reply with the product number you want.`;
    await sendWhatsAppMessage(phone, reply);
  }
  return;
}

if (productResult.status === "matched") {
  const product = productResult.product;
  const requestedSize = productResult.size || "Free Size";
  const quantity = productResult.quantity || 1;

  // ✅ Connect voice match → existing session/product-selection mechanism.
  // 1) selected_product_id gets the REAL Supabase product ID.
  await saveSelectedProduct(phone, product.id);

  // 2) Voice-requested size/quantity is carried in last_results (JSONB,
  //    reused as an object) + action_step="voice_single_pending" as the
  //    discriminator, so the existing ADD/SIZE STEP logic can read it later.
  //    Size is preserved as-is (null when not spoken) — no forced
  //    "Free Size" here. Uses only existing columns (last_results + action_step).
  try {
    const voiceSinglePayload = {
      voice_pending: true,
      type: "single_match",
      product_id: product.id,
      size: productResult.size || null,
      quantity: productResult.quantity || 1
    };

    const { data: existingSession, error: sessionFetchError } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    if (sessionFetchError) {
      console.error("❌ Failed to fetch session for voice single_match state:", sessionFetchError.message);
    } else if (existingSession) {
      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({ last_results: voiceSinglePayload, action_step: "voice_single_pending" })
        .eq("phone_number", phone);
      if (updateError) {
        console.error("❌ Failed to save voice single_match state (update):", updateError.message);
      }
    } else {
      const { error: insertError } = await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, last_results: voiceSinglePayload, action_step: "voice_single_pending" });
      if (insertError) {
        console.error("❌ Failed to save voice single_match state (insert):", insertError.message);
      }
    }
  } catch (sessionErr) {
    console.error("❌ Failed to save voice single_match state:", sessionErr.message);
  }

  const caption =
    `🛍️ *Product Details*\n\n` +
    `📦 Product: ${product.product_name}\n` +
    `💰 Price: ₹${product.price}\n` +
    `📏 Size: ${requestedSize}\n` +
    `🔢 Quantity: ${quantity}\n` +
    `📦 Stock: ${product.stock}`;

  const addButtons = [{ id: "ADD_PRODUCT", title: "🛒 Add to Cart" }];

  // Image + product details are now sent as ONE message (caption attached
  // directly to the image) instead of two separate Meta API calls. This
  // removes the race where Meta could finish processing the lighter
  // button message before the slower image message, causing the button
  // to visually appear before the image on the customer's phone even
  // though the image was sent first. The Add to Cart button is always
  // sent as the guaranteed follow-up message, after the image+details.
  let imageSentWithCaption = false;
  if (product.image_url) {
    const accessible = await isImageAccessible(product.image_url);
    if (accessible) {
      imageSentWithCaption = await sendWhatsAppImageMessage(phone, product.image_url, caption);
    }
  }

  if (!imageSentWithCaption) {
    // No image, or image failed — fall back to sending details as plain text
    // before the button, so details still always precede Add to Cart.
    await sendWhatsAppMessage(phone, caption);
  }

  const buttonsSent = await sendWhatsAppButtons(phone, `🛒 Ready to add *${product.product_name}* to your cart?`, addButtons);
  if (!buttonsSent) await sendWhatsAppMessage(phone, `Reply *ADD* to add this product to your cart.`);

  return;
}
  } catch (err) {
    console.error("❌ handleIncomingAudio error:", err.message);
    try {
      await sendWhatsAppMessage(phone, `⚠️ Something went wrong processing your voice message. Please type your order instead.`);
    } catch (fallbackErr) {
      console.error("❌ Voice fallback reply also failed:", fallbackErr.message);
    }
  }
}

// ─────────────────────────────────────────────────────────
// PHASE 2 — Meta audio media retrieval + download.
//
// downloadMetaMedia(mediaId) does two Graph API steps required by Meta's
// WhatsApp Cloud API for any inbound media (audio/image/document/etc):
//   1. GET  /{media-id}                → returns a short-lived media URL
//   2. GET  <that media URL>           → returns the actual binary bytes,
//                                         and MUST be authenticated with
//                                         the same Bearer access token.
//
// This reuses the existing META_ACCESS_TOKEN and META_MEDIA_BASE_URL
// (already defined above for Phase 1) — no new env vars, no hard-coded
// credentials, and no secret values are logged.
//
// Returns: { success: true, audioBuffer: Buffer, mimeType: string }
//      or: { success: false, reason: "..." }
// so callers (handleIncomingAudio, and eventually the Phase 3 AI layer)
// can branch on success/failure without re-implementing Graph API calls.
// ─────────────────────────────────────────────────────────
async function downloadMetaMedia(mediaId) {
  try {
    if (!mediaId) return { success: false, reason: "missing_media_id" };

    // Step 1 — resolve the temporary media URL from the media ID.
    console.log("🔍 Requesting Meta media information...");

    const metaRes = await fetch(`${META_MEDIA_BASE_URL}/${mediaId}`, {
      headers: { "Authorization": `Bearer ${META_ACCESS_TOKEN}` }
    });

    if (!metaRes.ok) {
      console.error("❌ downloadMetaMedia: failed to resolve media URL, status:", metaRes.status);
      return { success: false, reason: "media_info_failed", status: metaRes.status };
    }

    const metaData = await metaRes.json().catch(() => ({}));
    const mediaUrl = metaData?.url || null;
    const mimeType = metaData?.mime_type || "audio/ogg";

    if (!mediaUrl) {
      console.error("❌ downloadMetaMedia: no URL returned by Meta for mediaId:", mediaId);
      return { success: false, reason: "no_media_url" };
    }

    console.log("✅ Meta media URL received");

    // Step 2 — download the actual audio bytes from the temporary URL.
    // Same access token is required here too (Meta media URLs are not
    // publicly fetchable without the Bearer token).
    console.log("⬇️ Downloading audio...");

    const downloadRes = await fetch(mediaUrl, {
      headers: { "Authorization": `Bearer ${META_ACCESS_TOKEN}` }
    });

    if (!downloadRes.ok) {
      console.error("❌ downloadMetaMedia: audio download failed, status:", downloadRes.status);
      return { success: false, reason: "download_failed", status: downloadRes.status };
    }

    const arrayBuffer = await downloadRes.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Do not log audio contents — size/mimeType only, for debugging.
    console.log("✅ Audio downloaded successfully — size:", audioBuffer.length, "bytes, mimeType:", mimeType);

    // Returned in a form ready to be handed to the future AI voice-processing
    // module (Phase 3+). No AI call, no speech-to-text happens here.
    return { success: true, audioBuffer, mimeType };

  } catch (err) {
    console.error("❌ downloadMetaMedia error:", err.message);
    return { success: false, reason: "exception", error: err.message };
  }
}

// Phase 2 placeholder — validates/normalizes the AI's structured output
// before it's used to search the existing products table.
function extractVoiceOrderDetails(aiResult) {
  console.log("ℹ️ extractVoiceOrderDetails called — Phase 3 not yet implemented");
  return null;
}

// ─────────────────────────────────────────────────────────
// PHASE 6 — Connection point from the future AI voice-order result into
// the EXISTING StyleFlow product/cart/checkout/order system.
//
// This function does NOT call any AI. It only accepts the structured
// result AI will eventually produce:
//   { product_query: string, size?: string, quantity?: number }
//
// It reuses the EXISTING products table and EXISTING search pattern
// (same shape of query used by the text-search block in
// processIncomingMessage — ilike across product_name/category/color/size)
// so there is exactly one product lookup system, not a second one.
//
// It does NOT touch cart/orders itself — it only figures out which real
// product (if any single one matches) the voice request refers to, and
// returns a result describing what should happen next. The actual
// cart/session update and order placement continue to be done by the
// EXISTING functions (session updates, saveSelectedProduct, the "size"
// checkout_step flow, placeOrder, etc.) once the customer confirms —
// this function does not duplicate any of that.
//
// Returns one of:
//   { status: "not_found" }
//   { status: "clarification_needed", matches: [...] }
//   { status: "size_unavailable", product, availableSizes }
//   { status: "ready_for_confirmation", product, quantity }
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// PHASE 6 — Connection point that turns a matchProductFromVoiceRequest(...)
// result into a customer-facing confirmation message, using the SAME
// sendWhatsAppMessage/sendProductMessage helpers already used by the text
// flow. This does NOT create a cart entry or an order — it only asks the
// customer to confirm, exactly like the existing flow requires an explicit
// ADD / CHECKOUT / PAID before anything is written to cart/orders.
//
// Once AI is implemented (Phase 3-5) and the customer confirms (future
// phase), the EXISTING functions — saveSelectedProduct, the "size"
// checkout_step handling, and placeOrder — are what will actually write to
// cart/orders. This function is only the connection point / confirmation
// message, not a parallel order system.
// ─────────────────────────────────────────────────────────
async function sendVoiceOrderConfirmation(phone, matchedProduct, quantity) {
  console.log("ℹ️ sendVoiceOrderConfirmation called");

  if (!matchedProduct) {
    console.error("❌ sendVoiceOrderConfirmation: no matchedProduct provided");
    return;
  }

  const qty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;

  const confirmationText =
    `🎙️ *We heard your voice order!*\n\n` +
    `📦 Product: ${matchedProduct.product_name}\n` +
    `💰 Price: ₹${matchedProduct.price}\n` +
    `📐 Sizes: ${matchedProduct.size || 'Free Size'}\n` +
    `🔢 Quantity: ${qty}\n\n` +
    `─────────────────\n` +
    `This is a preview of what voice ordering will look like.\n` +
    `Type *ADD* to add this to your cart, or search/type to continue as normal.`;

  await sendWhatsAppMessage(phone, confirmationText);
}

async function saveSession(phone, data) {
  try {
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("user_sessions")
        .update({ last_results: data })
        .eq("phone_number", phone);
    } else {
      await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, last_results: data });
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function saveSelectedProduct(phone, productId) {
  try {
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("user_sessions")
        .update({ selected_product_id: productId })
        .eq("phone_number", phone);
    } else {
      await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, selected_product_id: productId });
    }
    return true;
  } catch (err) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// REPLY QUEUE — replaces Twilio's TwiML <Message> response.
// Meta's Cloud API has no "reply inline with the webhook ack"
// concept — every outbound message is its own Graph API call.
// This tiny shim lets the business logic below keep calling
// `twiml.message("...")` unchanged; we simply queue the text
// and flush it as real Meta API sends once the handler is done.
// ─────────────────────────────────────────────────────────
function createReplyQueue(phone, storeIdRef) {
  const queue = [];
  return {
    message(text) {
      queue.push({ kind: "text", text });
    },
    // ✅ Queue an interactive buttons message alongside plain text replies,
    // through the same flush pipeline. buttons: [{id, title}], max 3.
    buttons(bodyText, buttons, options = {}) {
      queue.push({ kind: "buttons", bodyText, buttons, options });
    },
    // ✅ Queue an interactive list message. sections: [{title, rows:[{id,title,description?}]}]
    list(bodyText, buttonText, sections, options = {}) {
      queue.push({ kind: "list", bodyText, buttonText, sections, options });
    },
    async flush() {
      for (const item of queue) {
        if (item.kind === "text") {
          await sendWhatsAppMessage(phone, item.text);
        } else if (item.kind === "buttons") {
          const sent = await sendWhatsAppButtons(phone, item.bodyText, item.buttons, item.options);
          if (!sent) {
            console.log("⚠️ Interactive buttons failed in reply queue — falling back to text");
            await sendWhatsAppMessage(phone, item.bodyText);
          }
        } else if (item.kind === "list") {
          const sent = await sendWhatsAppList(phone, item.bodyText, item.buttonText, item.sections, item.options);
          if (!sent) {
            console.log("⚠️ Interactive list failed in reply queue — falling back to text");
            await sendWhatsAppMessage(phone, item.bodyText);
          }
        }
      }
    }
  };
}

// No-op replacement for the old sendTwiml(res, twiml) — Meta webhooks
// must be ack'd immediately with 200 and contain no body; actual
// replies go out asynchronously via the Graph API.
async function sendTwiml(res, twiml) {
  await twiml.flush();
  if (!res.headersSent) res.status(200).end();
}

function buildPaymentOptionsMessage(paymentSettings, orderTotal, shopName, couponApplied) {
  const codEnabled = paymentSettings?.cod_enabled !== false;
  const upiEnabled = paymentSettings?.upi_enabled !== false;
  const minCod = paymentSettings?.minimum_cod_amount || 0;
  const instructions = paymentSettings?.payment_instructions || '';

  let msg = `💳 *Choose Payment Method*\n\n`;
  msg += `🧾 Order Total: ₹${orderTotal}\n`;
  if (couponApplied) {
    msg += `🎟️ _(Coupon applied — discount already deducted)_\n`;
  }
  msg += `\n`;

  if (!codEnabled && !upiEnabled) {
    return `⚠️ No payment methods are currently available. Please contact *${shopName}*.`;
  }

  if (codEnabled) {
    const codBlocked = minCod > 0 && orderTotal < minCod;
    if (codBlocked) {
      msg += `💵 Cash on Delivery — Minimum order ₹${minCod} required\n\n`;
    } else {
      msg += `💵 Cash on Delivery (COD)\n\n`;
    }
  }

  if (upiEnabled) {
    msg += `📱 Pay with UPI\n\n`;
  }

  if (instructions) {
    msg += `ℹ️ ${instructions}\n\n`;
  }

  return msg.trim();
}

// ✅ Derives the interactive button set using the exact same enabled/
// disabled/minimum-COD logic as buildPaymentOptionsMessage above (same
// inputs, same conditions) — never exposes a disabled payment method as
// selectable. Returns null when no methods are available (existing error
// text from buildPaymentOptionsMessage is used in that case instead).
function buildPaymentButtons(paymentSettings, orderTotal) {
  const codEnabled = paymentSettings?.cod_enabled !== false;
  const upiEnabled = paymentSettings?.upi_enabled !== false;
  const minCod = paymentSettings?.minimum_cod_amount || 0;
  const codBlocked = minCod > 0 && orderTotal < minCod;

  const buttons = [];
  if (codEnabled && !codBlocked) buttons.push({ id: "PAY_COD", title: "💵 Cash on Delivery" });
  if (upiEnabled) buttons.push({ id: "PAY_UPI", title: "📱 UPI" });

  return buttons.length > 0 ? buttons : null;
}

async function applyCouponAndRespond(phone, couponCode, storeId, orderTotal, shopName, twiml) {
  const result = await validateCoupon(couponCode, storeId, orderTotal);
  console.log("🎟️ Coupon validation result:", JSON.stringify(result));

  if (!result.valid) {
    let errorMsg = `⚠️ *Invalid coupon code.*\n\n`;
    if (result.reason === "expired") {
      errorMsg = `⏰ *Coupon expired.*\n\nThis offer ended on *${result.endDateFormatted}*.\n\n`;
    } else if (result.reason === "not_started") {
      errorMsg = `📅 *Coupon not yet active.*\n\nThis offer starts on *${result.startDateFormatted}*.\n\n`;
    } else if (result.reason === "min_order") {
      errorMsg = `🛍️ *Minimum order required.*\n\nThis coupon requires a minimum order of ₹${result.minOrder}.\nYour cart total is ₹${orderTotal}.\n\n`;
    }
    errorMsg += `Type your coupon code to try again, or skip below.`;

    await incrementStoreMessageUsage(storeId, "outgoing");
    twiml.buttons(errorMsg, [
      { id: "SKIP_COUPON", title: "⏭️ Skip Coupon" }
    ]);
    return { applied: false };
  }

  const discountedTotal = result.finalTotal;
  const discountAmount = result.discountAmount;
  const discountLabel = result.discountType === "percentage"
    ? `${result.discountValue}% off`
    : `₹${result.discountValue} off`;

  await supabase
    .from("user_sessions")
    .update({
      checkout_step: "payment",
      pending_store_id: storeId,
      pending_order_total: discountedTotal,
      applied_coupon_code: couponCode,
      applied_discount_amount: discountAmount
    })
    .eq("phone_number", phone);

  const paymentSettings = await getPaymentSettings(storeId);
  const paymentButtons = buildPaymentButtons(paymentSettings, discountedTotal);

  const couponPaymentBody =
    `🎉 *Coupon Applied!*\n\n` +
    `🎟️ Code: *${couponCode}*\n` +
    `💸 Discount: ${discountLabel} = *−₹${discountAmount}*\n` +
    `💰 New Total: *₹${discountedTotal}*\n\n` +
    `─────────────────\n` +
    buildPaymentOptionsMessage(paymentSettings, discountedTotal, shopName, true);

  await incrementStoreMessageUsage(storeId, "outgoing");
  if (paymentButtons) {
    twiml.buttons(couponPaymentBody, paymentButtons);
  } else {
    twiml.message(couponPaymentBody);
  }
  return { applied: true, discountedTotal, discountAmount };
}

// ─────────────────────────────────────────────────────────
// META WEBHOOK — GET verification
// ─────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔐 Webhook verification attempt — mode:", mode);

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("✅ Meta Webhook Verified");
    return res.status(200).send(challenge);
  }

  console.error("❌ Meta Webhook verification failed — token mismatch");
  return res.sendStatus(403);
});

// ─────────────────────────────────────────────────────────
// META WEBHOOK — POST receiver (replaces app.post("/whatsapp"))
// Parses the Meta Cloud API payload into the same internal
// variables (phone, msg, session, etc.) the business logic uses,
// so all downstream logic below is unchanged from the Twilio version.
// ─────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log("📩 Meta Incoming webhook:", JSON.stringify(body));

    // Always ack immediately — Meta requires a fast 200 or it retries/backoffs.
    res.sendStatus(200);

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Ignore status callbacks (sent/delivered/read receipts) — no message to process.
    if (!value?.messages || value.messages.length === 0) {
      if (value?.statuses) {
        console.log("ℹ️ Status callback received (delivery/read receipt) — ignoring.");
      }
      return;
    }

    const metaMessage = value.messages[0];
    

    // Normalize to the same "phone" shape the rest of the app expects.
    // Meta gives raw MSISDN (e.g. "919876543210"); we keep it consistent internally.
    const phone = metaMessage.from;

    // Extract message text depending on message type.
    let msg = "";
    if (metaMessage.type === "text") {
      msg = metaMessage.text?.body ? metaMessage.text.body.trim() : "";
    } else if (metaMessage.type === "interactive") {
      const interactive = metaMessage.interactive;
      if (interactive?.button_reply) {
        msg = interactive.button_reply.id || interactive.button_reply.title || "";
      } else if (interactive?.list_reply) {
        msg = interactive.list_reply.id || interactive.list_reply.title || "";
      }
      msg = msg.trim();
    } else if (metaMessage.type === "button") {
      msg = (metaMessage.button?.text || "").trim();
    } else if (metaMessage.type === "audio") {
      // Voice ordering — resolve the same store used by the customer session,
      // then pass it into the existing voice-order pipeline.

      const { data: audioSession, error: audioSessionError } = await supabase
        .from("user_sessions")
        .select("store_id, pending_store_id")
        .eq("phone_number", metaMessage.from)
        .maybeSingle();

      if (audioSessionError) {
        console.error(
          "❌ Could not resolve store for voice message:",
          audioSessionError.message
       );
      }

      const audioStoreId =
        audioSession?.store_id ||
        audioSession?.pending_store_id ||
        null;

      console.log("🏪 Voice message store ID:", audioStoreId);

      await handleIncomingAudio(
        metaMessage.from,
        metaMessage,
        audioStoreId
      );

      return;
    } else {
      console.log("ℹ️ Unsupported message type received:", metaMessage.type);
      await sendWhatsAppMessage(phone, `⚠️ Sorry, we only support text messages right now.`);
      return;
    }

    const msgLower = msg.toLowerCase();
    const msgUpper = msg.toUpperCase();
    const contact = value.contacts?.[0];

    // ✅ Extract sender phone and message from Meta payload
   
    console.log("=================================");
    console.log("📩 New message received (Meta)");
    console.log("PHONE:", phone);
    console.log("MESSAGE:", msg);
    console.log("=================================");

    // Ignore empty messages
    if (!phone || !msg) {
      console.log("⚠️ Empty phone or message received");
      return;
    }

    // Continue into your existing business logic
    await processIncomingMessage(phone, msg, msgLower, msgUpper);

  } catch (error) {
    console.error("❌ /webhook error:", error.stack || error.message);
    if (!res.headersSent) res.sendStatus(200); // still ack to avoid Meta retry storms
  }
});

// ─────────────────────────────────────────────────────────
// CORE BUSINESS LOGIC — identical behavior to the original
// Twilio app.post("/whatsapp") handler. Only the transport
// (how phone/msg arrive, and how replies are sent) changed.
// twiml.message(...) now queues a Meta text reply, flushed by sendTwiml().
// ─────────────────────────────────────────────────────────
async function processIncomingMessage(phone, msg, msgLower, msgUpper) {
  const fakeRes = { headersSent: false, status() { return this; }, end() {}, json() {} };
  const res = fakeRes;

  try {
    const twiml = createReplyQueue(phone);

    const { data: session } = await supabase
      .from("user_sessions")
      .select("*")
      .eq("phone_number", phone)
      .maybeSingle();

    console.log("📋 checkout_step:", session?.checkout_step || "none");
    console.log("📋 action_step:", session?.action_step || "none");
    console.log("📋 store_id:", session?.store_id || "none");

    const sessionStoreId = session?.store_id || null;
    const activeStoreId = sessionStoreId || session?.pending_store_id || null;

    if (activeStoreId) {
      await incrementStoreMessageUsage(activeStoreId, "incoming");
    }

    // ✅ CANCEL COMMAND
    if (msgLower === "cancel") {
      if (isInActiveOrderFlow(session)) {
        await clearOrderSession(phone);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(
          `🚫 *Order process cancelled.*\n\n` +
          `Your cart and current order progress have been cleared.\n\n` +
          `If you'd like to order again, just send the store code and start again! 🛍️`
        );
        return sendTwiml(res, twiml);
      }

      const lastOrder = await getLastPlacedOrder(phone, activeStoreId);
      if (lastOrder && ['pending', 'confirmed', 'shipped'].includes(lastOrder.status)) {
        const storeInfo = await getStorePhone(lastOrder.store_id);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(
          `⚠️ *Your order has already been placed.*\n\n` +
          `Order #${lastOrder.store_order_number || lastOrder.id} cannot be cancelled through WhatsApp.\n\n` +
          `Please contact *${storeInfo?.shop_name || 'the store'}*` +
          (storeInfo?.phone_number ? ` at *${storeInfo.phone_number}*` : '') +
          ` for assistance.`
        );
        return sendTwiml(res, twiml);
      }

      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.message(`ℹ️ There's no active order to cancel right now.\n\nSearch for products to start shopping! 🛍️`);
      return sendTwiml(res, twiml);
    }

    // ✅ CLEAR CART COMMAND
    if (msgLower === "clear cart" || msgUpper === "CLEAR CART") {
      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`🛒 Your cart is already empty.\n\nSearch for products to start shopping! 🛍️`);
        return sendTwiml(res, twiml);
      }

      await supabase.from("cart").delete().eq("phone_number", phone);
      await supabase
        .from("user_sessions")
        .update({ selected_product_id: null, action_step: null })
        .eq("phone_number", phone);

      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.message(`✅ *Cart cleared!*\n\nYour cart has been cleared. You can continue browsing and build a new order.\n\n🔍 Just type a product name to search!`);
      return sendTwiml(res, twiml);
    }

    // ✅ GLOBAL COUPON COMMAND — "COUPON CODE123" from anywhere
    if (msgUpper.startsWith("COUPON ") || msgUpper.startsWith("COUPON:")) {
      const couponCode = msg.replace(/^coupon:?\s*/i, "").trim();

      if (!couponCode) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Please type your coupon like this:\n*COUPON YOURCODE*`);
        return sendTwiml(res, twiml);
      }

      let storeId = session?.pending_store_id || sessionStoreId;
      let orderTotal = session?.pending_order_total || 0;

      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Your cart is empty!\n\nAdd products first, then apply your coupon.`);
        return sendTwiml(res, twiml);
      }

      if (!storeId) {
        const { data: firstProduct } = await supabase
          .from("products").select("store_id")
          .eq("id", cartItems[0].product_id).maybeSingle();
        if (firstProduct?.store_id) storeId = firstProduct.store_id;
      }

      if (!orderTotal) {
        orderTotal = 0;
        for (const item of cartItems) {
          const { data: product } = await supabase
            .from("products").select("price")
            .eq("id", item.product_id).maybeSingle();
          if (product) orderTotal += product.price * item.quantity;
        }
      }

      const shopName = await getShopName(storeId);
      await applyCouponAndRespond(phone, couponCode, storeId, orderTotal, shopName, twiml);
      return sendTwiml(res, twiml);
    }

    // ✅ 1. GREETING
    if (GREETINGS.includes(msgLower)) {
      let storeId = sessionStoreId;
      if (!storeId) {
        storeId = await getStoreIdForCustomer(phone);
        if (storeId) await saveStoreToSession(phone, storeId);
      }

      const shopName = await getShopName(storeId);

      if (!storeId) {
        await sendWhatsAppMessage(
          phone,
          `👋 Welcome to *StyleFlow*! 🛍️\n\nTo get started, please enter your *Store Code*.\n\n_Your store owner will share the store code with you._`
        );
      } else {
        await incrementStoreMessageUsage(storeId, "outgoing");
        await sendWhatsAppMessage(
          phone,
          `👋 Welcome to *${shopName}*! 🛍️\n\nWe are your personal fashion assistant.\n\n🔍 *How to shop:*\nJust type what you are looking for!\n\nExamples:\n• Type *Black* to see black products\n• Type *Jeans* to see all jeans\n\n📦 Type *ORDER STATUS* to check latest order\n\nHappy Shopping! 🎉`
        );
      }
      return;
    }

    // ✅ 2. STORE CODE CHECK
    if (!session?.store_id || !session?.checkout_step) {
      const storeByCode = await getStoreByCode(msgUpper);
      if (storeByCode) {
        await saveStoreToSession(phone, storeByCode.id);
        await incrementStoreMessageUsage(storeByCode.id, "incoming");
        await incrementStoreMessageUsage(storeByCode.id, "outgoing");
        await sendWhatsAppMessage(
          phone,
          `✅ *${storeByCode.shop_name}* store selected!\n\n👋 Welcome! We are your personal fashion assistant.\n\n🔍 *How to shop:*\nJust type what you are looking for!\n\nExamples:\n• Type *Black* to see black products\n• Type *Jeans* to see all jeans\n\n📦 Type *ORDER STATUS* to check latest order\n\nHappy Shopping! 🎉`
        );
        return;
      }
    }

    // ✅ 3. CHECKOUT STEP — COUPON
    if (session?.checkout_step === "coupon") {
      const storeId = session.pending_store_id || sessionStoreId;
      const orderTotal = session.pending_order_total || 0;
      const shopName = await getShopName(storeId);

      if (msgUpper === "SKIP" || msgUpper === "NO" || msgLower === "skip" || msgLower === "no" || msgUpper === "SKIP_COUPON") {
        await supabase
          .from("user_sessions")
          .update({
            checkout_step: "payment",
            applied_coupon_code: null,
            applied_discount_amount: null
          })
          .eq("phone_number", phone);

        const paymentSettings = await getPaymentSettings(storeId);
        const paymentButtons = buildPaymentButtons(paymentSettings, orderTotal);
        const paymentBody = buildPaymentOptionsMessage(paymentSettings, orderTotal, shopName, false);

        await incrementStoreMessageUsage(storeId, "outgoing");
        if (paymentButtons) {
          twiml.buttons(paymentBody, paymentButtons);
        } else {
          twiml.message(paymentBody);
        }
        return sendTwiml(res, twiml);
      }

      const couponCode = msg.trim();
      await applyCouponAndRespond(phone, couponCode, storeId, orderTotal, shopName, twiml);
      return sendTwiml(res, twiml);
    }

    // ✅ 4. CHECKOUT STEP — PAYMENT
    if (session?.checkout_step === "payment") {
      const storeId = session.pending_store_id || sessionStoreId;
      const orderTotal = session.pending_order_total || 0;
      const shopName = await getShopName(storeId);
      const paymentSettings = await getPaymentSettings(storeId);

      const codEnabled = paymentSettings?.cod_enabled !== false;
      const upiEnabled = paymentSettings?.upi_enabled !== false;
      const minCod = paymentSettings?.minimum_cod_amount || 0;

      if (msg === "1" || msgUpper === "COD" || msgUpper === "CASH ON DELIVERY" || msgUpper === "PAY_COD") {
        if (!codEnabled) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ Cash on Delivery is not available.\n\nPlease type *2* to pay with UPI.`);
          return sendTwiml(res, twiml);
        }
        if (minCod > 0 && orderTotal < minCod) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ COD requires minimum order of ₹${minCod}.\n\nYour order total is ₹${orderTotal}.\n\nPlease type *2* to pay with UPI.`);
          return sendTwiml(res, twiml);
        }
        await placeOrder(phone, session, storeId, orderTotal, shopName, "COD", "pending", res, twiml);
        return;
      }

      if (msg === "2" || msgUpper === "UPI" || msgUpper === "PAY WITH UPI" || msgUpper === "PAY_UPI") {
        if (!upiEnabled) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ UPI payment is not available.\n\nPlease type *1* to use Cash on Delivery.`);
          return sendTwiml(res, twiml);
        }

        const upiId = paymentSettings?.upi_id;
        const instructions = paymentSettings?.payment_instructions;

        if (!upiId) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ UPI payment is not configured for this store.\n\nPlease type *1* for Cash on Delivery or contact *${shopName}*.`);
          return sendTwiml(res, twiml);
        }

        // Prevent duplicate order/link creation on retry: if this session
        // already has a pending online-payment order with a Payment Link,
        // reuse it instead of creating a second order + second link.
        if (session.pending_online_order_id && session.razorpay_payment_link_url) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          await sendWhatsAppMessage(
            phone,
            `📱 *Complete Your Online Payment*\n\n` +
            `🧾 Amount: *₹${orderTotal}*\n\n` +
            `👉 Pay Now: ${session.razorpay_payment_link_url}\n\n` +
            `─────────────────\nOr type *CANCEL* to cancel this order.`
          );
          return sendTwiml(res, twiml);
        }

        // ── Step 1: create the pending StyleFlow order BEFORE payment ──
        const pendingOrderResult = await createPendingOnlineOrder(phone, session, storeId, orderTotal, shopName);

        if (!pendingOrderResult.success) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ We couldn't set up your order right now. Please try again in a moment, or type *1* for Cash on Delivery.`);
          return sendTwiml(res, twiml);
        }

        const pendingOrder = pendingOrderResult.order;

        // ── Step 2: create a Razorpay Payment Link tied to that order ──
        let paymentLinkUrl = null;
        let paymentLinkId = null;
        try {
          const paymentLink = await razorpay.paymentLink.create({
            amount: Math.round(orderTotal * 100),
            currency: "INR",
            accept_partial: false,
            description: `Payment for order #${pendingOrder.store_order_number} at ${shopName}`,
            customer: {
              contact: phone
            },
            notify: { sms: false, email: false },
            reference_id: `styleflow_order_${pendingOrder.id}`,
            notes: {
              styleflow_order_id: String(pendingOrder.id),
              phone: phone,
              store_id: String(storeId)
            }
          });
          paymentLinkUrl = paymentLink?.short_url || null;
          paymentLinkId = paymentLink?.id || null;
        } catch (linkErr) {
          console.error("❌ Razorpay Payment Link creation error:", linkErr.message);
        }

        if (!paymentLinkUrl) {
          // Payment Link failed — leave the pending order as-is (status
          // stays "pending" / payment_status "pending"); do not tell the
          // customer payment is ready. Clear session pointers so a retry
          // is possible without ambiguity.
          console.error("❌ Payment Link creation failed for order:", pendingOrder.id);
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ We couldn't generate the payment link right now. Please try again in a moment, or type *1* for Cash on Delivery.`);
          return sendTwiml(res, twiml);
        }

        // ── Step 3: save the Payment Link → order mapping ──
        await supabase
          .from("orders")
          .update({
            razorpay_payment_link_id: paymentLinkId
          })
          .eq("id", pendingOrder.id);

        const { error: sessionUpdateError } = await supabase
          .from("user_sessions")
          .update({
            checkout_step: "awaiting_payment",
            payment_method: "UPI",
            pending_online_order_id: pendingOrder.id,
            razorpay_payment_link_url: paymentLinkUrl
          })
          .eq("phone_number", phone);

        if (sessionUpdateError) {
          console.error(
            "❌ Failed to save online payment session:",
            sessionUpdateError.message
          );
          console.error("Session update details:", sessionUpdateError);
        }

        // ── Step 4: send the payment link to the customer ──
        let upiMsg =
          `💳 *Complete Your Online Payment*\n\n` +
          `💰 Total: *₹${orderTotal}*\n\n`;

        if (session.applied_coupon_code) {
          upiMsg += `🎟️ Coupon *${session.applied_coupon_code}* applied ✅\n\n`;
        }

        upiMsg +=
          `Tap below to complete your payment:\n\n` +
          `🔗 Pay Now: ${paymentLinkUrl}\n\n`;

        if (instructions) upiMsg += `ℹ️ ${instructions}\n\n`;
        upiMsg += `─────────────────\nOr type *CANCEL* to cancel this order.`;

        await incrementStoreMessageUsage(storeId, "outgoing");
        await sendWhatsAppMessage(phone, upiMsg);

        return sendTwiml(res, twiml);
      }
      if (msgUpper.startsWith("COUPON ") || msgUpper.startsWith("COUPON:")) {
        const couponCode = msg.replace(/^coupon:?\s*/i, "").trim();
        if (!couponCode) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ Please type your coupon like this:\n*COUPON SAVE20*`);
          return sendTwiml(res, twiml);
        }
        const baseTotal = session.applied_coupon_code && session.applied_discount_amount
          ? orderTotal + Number(session.applied_discount_amount)
          : orderTotal;
        await applyCouponAndRespond(phone, couponCode, storeId, baseTotal, shopName, twiml);
        return sendTwiml(res, twiml);
      }

      const invalidPaymentBody =
        `⚠️ Invalid selection.\n\n` +
        buildPaymentOptionsMessage(paymentSettings, orderTotal, shopName, !!session.applied_coupon_code);
      const invalidPaymentButtons = buildPaymentButtons(paymentSettings, orderTotal);

      await incrementStoreMessageUsage(storeId, "outgoing");
      if (invalidPaymentButtons) {
        twiml.buttons(invalidPaymentBody, invalidPaymentButtons);
      } else {
        twiml.message(invalidPaymentBody);
      }
      return sendTwiml(res, twiml);
    }

    // ✅ 5. CHECKOUT STEP — AWAITING UPI PAYMENT
    if (session?.checkout_step === "awaiting_payment") {
      const storeId = session.pending_store_id || sessionStoreId;
      const orderTotal = session.pending_order_total || 0;

      if (msgUpper === "PAID" || msgUpper === "I'VE PAID" || msgUpper === "DONE") {
        const shopName = await getShopName(storeId);
        await placeOrder(phone, session, storeId, orderTotal, shopName, "UPI", "awaiting_verification", res, twiml);
        return;
      } else {
        const paymentSettings = await getPaymentSettings(storeId);
        const upiId = paymentSettings?.upi_id || 'N/A';
        await incrementStoreMessageUsage(storeId, "outgoing");
        twiml.message(
          `⏳ *Waiting for your payment*\n\n` +
          `Please complete payment of *₹${orderTotal}*\n` +
          `to UPI ID: *${upiId}*\n\n` +
          `After paying, type *PAID* to confirm.\n` +
          `Or type *CANCEL* to cancel this order.`
        );
        return sendTwiml(res, twiml);
      }
    }

    // ✅ 6. CHECKOUT STEP — NAME + PHONE
    if (session?.checkout_step === "name_phone") {
      const trimmed = msg.trim();
      const parts = trimmed.split(/\s+/);
      const lastPart = parts[parts.length - 1];
      const phoneDigits = lastPart.replace(/\D/g, '');
      const isValidPhone = phoneDigits.length >= 10 && phoneDigits.length <= 15;
      const customerName = parts.slice(0, parts.length - 1).join(' ').trim();

      if (!isValidPhone || !customerName) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `⚠️ Please send your *name and phone number* together.\n\n` +
          `Example:\n*Vijay 1234567890*\n\n` +
          `Type your full name followed by your phone number.`
        );
        return sendTwiml(res, twiml);
      }

      await supabase
        .from("user_sessions")
        .update({
          customer_name: customerName,
          customer_phone: phoneDigits,
          checkout_step: "address_pincode"
        })
        .eq("phone_number", phone);

      await incrementStoreMessageUsage(sessionStoreId, "outgoing");
      twiml.message(
        `✅ Got it, *${customerName}*!\n\n` +
        `📍 Now please send your *delivery address and pincode* together.\n\n` +
        `Example:\n*12 Main Street, Chennai 600001*\n\n` +
        `Type your full address followed by your 6-digit pincode.`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 7. ADDRESS + PINCODE
    if (session?.checkout_step === "address_pincode") {
      console.log("📍 address_pincode step:", msg);
      console.log("📍 FULL session row at entry:", JSON.stringify(session));

      const trimmed = msg.trim();

      if (msg === "1" || msg === "2") {
        if (!session.customer_address && !session.pending_order_total) {
          const recoveryStoreId = sessionStoreId || session.pending_store_id;
          const savedAddress = await getSavedAddress(phone, recoveryStoreId);

          if (savedAddress) {
            await supabase
              .from("user_sessions")
              .update({
                checkout_step: "saved_address_choice",
                action_step: null,
                saved_address_data: JSON.stringify(savedAddress)
              })
              .eq("phone_number", phone);

            await incrementStoreMessageUsage(recoveryStoreId, "outgoing");
            twiml.message(
              `📍 *Saved Delivery Address*\n\n` +
              `👤 ${savedAddress.customer_name}\n` +
              `🏠 ${savedAddress.address}\n\n` +
              `Reply:\n` +
              `*1* — Use Saved Address\n` +
              `*2* — Add New Address`
            );
            return sendTwiml(res, twiml);
          }

          await incrementStoreMessageUsage(sessionStoreId, "outgoing");
          twiml.message(
            `⚠️ Please send your *full delivery address and pincode* together.\n\n` +
            `Example:\n*12 Main Street, Chennai 600001*\n\n` +
            `Or type *cancel* to stop checkout.`
          );
          return sendTwiml(res, twiml);
        }
      }

      if (msgLower === "cancel") {
        await supabase
          .from("user_sessions")
          .update({
            checkout_step: null,
            action_step: null,
            pending_store_id: null,
            pending_order_total: null
          })
          .eq("phone_number", phone);

        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message("❌ Checkout cancelled.");
        return sendTwiml(res, twiml);
      }

      const pincodeMatch = trimmed.match(/\b(\d{6})\b/);

      if (!pincodeMatch || trimmed.length < 10) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `⚠️ Invalid address format.\n\n` +
          `Please send your *full address + 6-digit pincode* in one message.\n\n` +
          `Example:\n*12 Main Street, Chennai 600001*\n\n` +
          `Or type *cancel* to stop checkout.`
        );
        return sendTwiml(res, twiml);
      }

      const pincode = pincodeMatch[1];
      const address = trimmed
        .replace(pincodeMatch[0], '')
        .replace(/,\s*$/, '')
        .trim();

      if (!address || address.length < 5) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `⚠️ Please include your *full address* along with the pincode.\n\n` +
          `Example:\n*12 Main Street, Chennai 600001*`
        );
        return sendTwiml(res, twiml);
      }

      const fullAddress = `${address}, ${pincode}`;
      console.log("📍 Parsed address:", address, "| pincode:", pincode);

      const { data: cartItems } = await supabase
        .from("cart")
        .select("*")
        .eq("phone_number", phone);

      console.log("🛒 address step cartItems:", cartItems);

      if (!cartItems || cartItems.length === 0) {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: null })
          .eq("phone_number", phone);

        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(`⚠️ Your cart is empty!`);
        return sendTwiml(res, twiml);
      }

      let storeId = sessionStoreId;
      if (!storeId) {
        const { data: firstProduct } = await supabase
          .from("products")
          .select("store_id")
          .eq("id", cartItems[0].product_id)
          .maybeSingle();
        if (firstProduct?.store_id) storeId = firstProduct.store_id;
      }

      let orderTotal = 0;
      for (const item of cartItems) {
        const { data: product } = await supabase
          .from("products")
          .select("price")
          .eq("id", item.product_id)
          .maybeSingle();
        if (product) orderTotal += product.price * item.quantity;
      }

      const nextStep = "coupon";

      const sessionUpdatePayload = {
        customer_address: fullAddress,
        checkout_step: nextStep,
        pending_store_id: storeId,
        pending_order_total: orderTotal
      };

      let updateError = null;
      const { error: firstUpdateError } = await supabase
        .from("user_sessions")
        .update({ ...sessionUpdatePayload, customer_pincode: pincode })
        .eq("phone_number", phone);

      if (firstUpdateError) {
        console.log("⚠️ customer_pincode column missing — updating without it:", firstUpdateError.message);
        const { error: retryError } = await supabase
          .from("user_sessions")
          .update(sessionUpdatePayload)
          .eq("phone_number", phone);
        updateError = retryError;
      }

      if (updateError) {
        console.error("❌ Session update failed:", updateError.message);
        await incrementStoreMessageUsage(storeId, "outgoing");
        twiml.message(`⚠️ Something went wrong saving your address. Please try again.`);
        return sendTwiml(res, twiml);
      }

      console.log(`✅ Address saved — step moved to: ${nextStep}`);

      const couponPromptBody =
        `✅ *Address saved!*\n\n` +
        `─────────────────\n` +
        `🎟️ *Apply Coupon Code?*\n\n` +
        `🧾 Cart Total: *₹${orderTotal}*\n\n` +
        `If you have a coupon, type it now.\n` +
        `Example: *SAVE20*`;

      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.buttons(couponPromptBody, [
        { id: "SKIP_COUPON", title: "⏭️ Skip Coupon" }
      ]);
      return sendTwiml(res, twiml);
    }

    // ✅ 8. CHECKOUT STEP — SAVED ADDRESS CHOICE
    if (session?.checkout_step === "saved_address_choice") {
      if (msg === "1" || msgUpper === "USE SAVED ADDRESS" || msgUpper === "USE_SAVED_ADDRESS") {
        const savedAddress = session.saved_address_data
          ? JSON.parse(session.saved_address_data)
          : null;

        if (!savedAddress) {
          await supabase.from("user_sessions").update({ checkout_step: "name_phone" }).eq("phone_number", phone);
          await incrementStoreMessageUsage(sessionStoreId, "outgoing");
          twiml.message(
            `⚠️ No saved address found.\n\n` +
            `👤 Please send your *name and phone number* together.\n\n` +
            `Example: *Vijay 1234567890*`
          );
          return sendTwiml(res, twiml);
        }

        const { data: cartItems } = await supabase
          .from("cart").select("*").eq("phone_number", phone);

        let orderTotal = 0;
        for (const item of cartItems || []) {
          const { data: product } = await supabase
            .from("products").select("price")
            .eq("id", item.product_id).maybeSingle();
          if (product) orderTotal += product.price * item.quantity;
        }

        let storeId = sessionStoreId;
        if (!storeId && cartItems && cartItems.length > 0) {
          const { data: firstProduct } = await supabase
            .from("products").select("store_id")
            .eq("id", cartItems[0].product_id).maybeSingle();
          if (firstProduct?.store_id) storeId = firstProduct.store_id;
        }

        await supabase
          .from("user_sessions")
          .update({
            customer_name: savedAddress.customer_name,
            customer_address: savedAddress.address,
            checkout_step: "coupon",
            pending_store_id: storeId,
            pending_order_total: orderTotal
          })
          .eq("phone_number", phone);

        const couponPromptBody2 =
          `✅ *Address confirmed!*\n\n` +
          `─────────────────\n` +
          `🎟️ *Apply Coupon Code?*\n\n` +
          `🧾 Cart Total: *₹${orderTotal}*\n\n` +
          `If you have a coupon, type it now.\n` +
          `Example: *SAVE20*`;

        await incrementStoreMessageUsage(storeId, "outgoing");
        twiml.buttons(couponPromptBody2, [
          { id: "SKIP_COUPON", title: "⏭️ Skip Coupon" }
        ]);
        return sendTwiml(res, twiml);
      }

      if (msg === "2" || msgUpper === "ADD NEW ADDRESS" || msgUpper === "NEW ADDRESS" || msgUpper === "ADD_NEW_ADDRESS") {
        await supabase.from("user_sessions").update({ checkout_step: "name_phone" }).eq("phone_number", phone);
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `👤 Please send your *name and phone number* together.\n\n` +
          `Example: *Vijay 1234567890*`
        );
        return sendTwiml(res, twiml);
      }

      const sent = await sendWhatsAppButtons(phone, `⚠️ Please choose an option:`, [
        { id: "USE_SAVED_ADDRESS", title: "📍 Use Saved" },
        { id: "ADD_NEW_ADDRESS", title: "🏠 New Address" }
      ]);
      if (sent) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
      } else {
        twiml.message(`⚠️ Please reply:\n\n*1* — Use Saved Address\n*2* — Add New Address`);
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
      }
      return sendTwiml(res, twiml);
    }

    // ✅ 8b. VOICE MULTIPLE-MATCH PRODUCT SELECTION
    // Must run BEFORE the SIZE STEP handler and BEFORE the normal text
    // "NUMBER CHECK" handler, so a numeric reply to a voice multiple-match
    // prompt is never misread as a size or as a text-search selection.
    // Uses only EXISTING columns: action_step as the discriminator, and
    // last_results (JSONB) reused as an object instead of the plain array
    // normal text search stores there.
    // Accepts either the interactive list ID (VOICE_PRODUCT_<id>) or the
    // legacy numeric reply ("1", "2", ...) as fallback.
    const isVoiceProductId = msgUpper.startsWith("VOICE_PRODUCT_");
    const isNumericReply = /^[0-9]+$/.test(msg.trim());

    if (session?.action_step === "voice_multi_pending" && (isVoiceProductId || isNumericReply)) {
      const voiceMultiState = session?.last_results && !Array.isArray(session.last_results)
        ? session.last_results
        : null;

      const matches = voiceMultiState && Array.isArray(voiceMultiState.matches) ? voiceMultiState.matches : [];

      // ✅ Resolve the chosen product ID from either input form.
      let chosenId = null;
      if (isVoiceProductId) {
        chosenId = msgUpper.slice("VOICE_PRODUCT_".length);
      } else {
        const chosenIndex = parseInt(msg.trim(), 10) - 1;
        if (voiceMultiState && chosenIndex >= 0 && chosenIndex < matches.length) {
          chosenId = matches[chosenIndex]?.id;
        }
      }

      if (!voiceMultiState || !chosenId) {
        await supabase.from("user_sessions").update({ action_step: null, last_results: null }).eq("phone_number", phone);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(matches.length ? `⚠️ Invalid selection. Choose between *1* and *${matches.length}*` : `⚠️ Session expired. Please search again!`);
        return sendTwiml(res, twiml);
      }

      // ✅ Store isolation: validate the chosen product actually belongs to
      // the current active store before trusting the client-supplied ID.
      const { data: chosenProduct } = await supabase
        .from("products").select("*")
        .eq("id", chosenId)
        .eq("store_id", activeStoreId)
        .maybeSingle();

      if (!chosenProduct) {
        await supabase.from("user_sessions")
          .update({ action_step: null, last_results: null })
          .eq("phone_number", phone);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      // ✅ Reuse the existing selection mechanism — real product ID only.
      await saveSelectedProduct(phone, chosenProduct.id);

      // ✅ Collapse the multi-match state into the single-match voice shape,
      // stored in last_results with action_step="voice_single_pending", so
      // the existing (already-fixed) ADD / SIZE STEP logic below handles it
      // exactly like a direct voice match — no separate code path.
      const collapsedPayload = {
        voice_pending: true,
        type: "single_match",
        product_id: chosenProduct.id,
        size: voiceMultiState.size || null,
        quantity: voiceMultiState.quantity || 1
      };

      const { error: collapseError } = await supabase
        .from("user_sessions")
        .update({ last_results: collapsedPayload, action_step: "voice_single_pending" })
        .eq("phone_number", phone);

      if (collapseError) {
        console.error("❌ Failed to save selected voice product state:", collapseError.message);
      }

      const requestedSize = voiceMultiState.size || "Free Size";
      const quantity = voiceMultiState.quantity || 1;

      const caption =
        `🛍️ *Product Details*\n\n` +
        `📦 Product: ${chosenProduct.product_name}\n` +
        `💰 Price: ₹${chosenProduct.price}\n` +
        `📏 Size: ${requestedSize}\n` +
        `🔢 Quantity: ${quantity}\n` +
        `📦 Stock: ${chosenProduct.stock}`;

      // Same fix as the voice single-match path: image + product details
      // sent as ONE message (caption attached to the image) instead of two
      // separate Meta API calls, removing the race where the lighter button
      // message could visually render before the slower image message even
      // though the image was sent first.
      let imageSentWithCaption = false;
      if (chosenProduct.image_url) {
        const accessible = await isImageAccessible(chosenProduct.image_url);
        if (accessible) {
          imageSentWithCaption = await sendWhatsAppImageMessage(phone, chosenProduct.image_url, caption);
          if (imageSentWithCaption) await incrementStoreMessageUsage(activeStoreId, "outgoing");
        }
      }

      if (!imageSentWithCaption) {
        await sendWhatsAppMessage(phone, caption);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
      }

      const buttonsSent = await sendWhatsAppButtons(phone, `🛒 Ready to add *${chosenProduct.product_name}* to your cart?`, [
        { id: "ADD_PRODUCT", title: "🛒 Add to Cart" }
      ]);
      if (buttonsSent) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
      } else {
        await sendWhatsAppMessage(phone, `Reply *ADD* to add this product to your cart.`);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
      }
      return;
    }
    // ✅ 9. SIZE STEP
    // ✅ Guard: control commands (text or interactive ID form) are NOT size
    // replies — let them fall through to their authoritative handlers below
    // instead of being validated as an invalid size string.
    const isControlCommand =
      msgUpper === "ADD" || msgUpper === "ADD_PRODUCT" ||
      msgUpper === "CART" || msgUpper === "VIEW_CART" ||
      msgUpper === "CHECKOUT";

    if (session?.checkout_step === "size" && !isControlCommand) {
      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", session.selected_product_id).maybeSingle();

      if (!product) {
        await supabase.from("user_sessions").update({ checkout_step: null }).eq("phone_number", phone);
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      const availableSizes = product.size
        ? product.size.split(',').map(s => s.trim().toUpperCase())
        : [];

      // ✅ Accept both typed size text ("M") and interactive list/button IDs
      // (e.g. "SIZE_M") — normalize either into the plain size token.
      const rawInput = msg.trim().toUpperCase();
      const enteredSize = rawInput.startsWith("SIZE_") ? rawInput.slice(5) : rawInput;

      if (availableSizes.length > 0 && !availableSizes.includes(enteredSize)) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        const sizeRows = availableSizes.map(s => ({ id: `SIZE_${s}`, title: s }));
        if (availableSizes.length > 3) {
          twiml.list(
            `⚠️ *"${msg}"* is not a valid size.\n\nPlease choose from the list:`,
            "Choose Size",
            [{ title: "Available Sizes", rows: sizeRows }]
          );
        } else {
          twiml.buttons(`⚠️ *"${msg}"* is not a valid size.\n\nPlease choose from: *${product.size}*`, sizeRows);
        }
        return sendTwiml(res, twiml);
      }

      const finalSize = availableSizes.length > 0 ? enteredSize : msg.trim();

      // ✅ Preserve voice-requested quantity (Case 2): if a still-pending
      // voice single-match state belongs to this product, use its quantity
      // instead of defaulting to 1. Normal text ADD is unaffected
      // (voicePendingForSize is null when there's no matching pending
      // voice data — action_step won't be "voice_single_pending").
      const voicePendingForSize = (session?.action_step === "voice_single_pending" && session?.last_results && !Array.isArray(session.last_results))
        ? session.last_results
        : null;
      const voiceQuantityMatches = !!(voicePendingForSize && voicePendingForSize.product_id === session.selected_product_id);
      const quantityToUse = voiceQuantityMatches ? (voicePendingForSize.quantity || 1) : 1;

      const { data: existingCart } = await supabase
        .from("cart").select("*")
        .eq("phone_number", phone)
        .eq("product_id", session.selected_product_id)
        .maybeSingle();

      if (existingCart) {
        const { error: updateError } = await supabase
          .from("cart")
          .update({ quantity: existingCart.quantity + quantityToUse, size: finalSize })
          .eq("id", existingCart.id);

        if (updateError) {
          await incrementStoreMessageUsage(sessionStoreId, "outgoing");
          twiml.message(`⚠️ Cart error: ${updateError.message}`);
          return sendTwiml(res, twiml);
        }

        const cartUpdatedBody =
          `✅ *Cart Updated!*\n\n` +
          `📦 ${product.product_name}\n` +
          `📐 Size: *${finalSize}*\n` +
          `💰 ₹${product.price}\n` +
          `🔢 Qty: ${existingCart.quantity + quantityToUse}\n\n` +
          `What would you like to do next?`;
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.buttons(cartUpdatedBody, [
          { id: "VIEW_CART", title: "👀 View Cart" },
          { id: "CHECKOUT", title: "✅ Checkout" },
          { id: "CONTINUE_SHOPPING", title: "🔍 Continue" }
        ]);
      } else {
        const { error: insertError } = await supabase
          .from("cart")
          .insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: quantityToUse,
            size: finalSize
          });

        if (insertError) {
          await incrementStoreMessageUsage(sessionStoreId, "outgoing");
          twiml.message(`⚠️ Cart error: ${insertError.message}`);
          return sendTwiml(res, twiml);
        }

        const addedToCartBody =
          `✅ *Added to Cart!*\n\n` +
          `📦 ${product.product_name}\n` +
          `📐 Size: *${finalSize}*\n` +
          `💰 ₹${product.price}\n` +
          `🔢 Qty: ${quantityToUse}\n\n` +
          `What would you like to do next?`;
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.buttons(addedToCartBody, [
          { id: "VIEW_CART", title: "👀 View Cart" },
          { id: "CHECKOUT", title: "✅ Checkout" },
          { id: "CONTINUE_SHOPPING", title: "🔍 Continue" }
        ]);
      }

      await supabase
        .from("user_sessions")
        .update({
          checkout_step: null,
          action_step: "product_action",
          last_results: voiceQuantityMatches ? null : undefined
        })
        .eq("phone_number", phone);

      return sendTwiml(res, twiml);
    }

    // ✅ 10. ORDER STATUS
    if (msgUpper === "ORDER STATUS" || msgUpper === "STATUS" || msgUpper === "MY ORDER") {
      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("phone_number", phone)
        .order("id", { ascending: false })
        .limit(1);

      if (!orders || orders.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`📦 *No orders found!*\n\nYou have not placed any orders yet.\n\nSearch for products to start shopping! 🛍️`);
        return sendTwiml(res, twiml);
      }

      const order = orders[0];
      const emoji = getStatusEmoji(order.status);
      const itemsText = await getOrderItems(order.id);

      await incrementStoreMessageUsage(order.store_id || activeStoreId, "outgoing");
      twiml.message(
        `📦 *Latest Order Status*\n\n` +
        `🆔 Order #${order.store_order_number || order.id}\n` +
        `${emoji} Status: *${order.status.toUpperCase()}*\n` +
        `💳 Payment: *${order.payment_method || 'N/A'}* — ${order.payment_status || 'N/A'}\n\n` +
        `🛍️ *Items:*\n${itemsText}\n\n` +
        `👤 ${order.customer_name || 'N/A'}\n` +
        `📍 ${order.customer_address || 'N/A'}\n` +
        `🕐 ${formatDate(order.created_at)}`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 11. ADD — top level
    // ✅ Accept both the typed text command and its interactive button ID.
    if (msgUpper === "ADD" || msgUpper === "ADD_PRODUCT") {

      // ✅ Check for voice-order pending product in session (action_step
      // discriminator + last_results reused as an object).
      const voicePending = (session?.action_step === "voice_single_pending" && session?.last_results && !Array.isArray(session.last_results))
        ? session.last_results
        : null;

      // ✅ Priority fix: a CURRENT valid voice pending product must take
      // priority over a stale selected_product_id from an older normal
      // text selection. Previously selected_product_id always won even
      // when it was stale, which could point ADD at the wrong product.
      const productIdToUse = voicePending?.product_id || session?.selected_product_id || null;

      if (!productIdToUse) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Please select a product first by searching!`);
        return sendTwiml(res, twiml);
      }

      // ✅ Always fetch fresh product from Supabase — truth source
      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", productIdToUse).maybeSingle();

      if (!product) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      // ✅ Determine whether the pending voice data actually belongs to this product
      const voicePendingMatches = !!(voicePending && voicePending.product_id === productIdToUse);

      // ✅ Determine quantity — voice pending uses its qty, normal text uses 1
      const quantityToAdd = voicePendingMatches
        ? (voicePending.quantity || 1)
        : 1;

      // ✅ Determine size — voice pending may already have a valid size
      const voiceRequestedSize = voicePendingMatches
        ? voicePending.size || null
        : null;

      const availableSizes = product.size
        ? product.size.split(',').map(s => s.trim().toUpperCase())
        : [];

      // ✅ For voice order: if size is provided and valid, skip size-selection step
      // For normal text order: keep existing size-selection behavior exactly
      if (product.size && product.size.trim() !== '') {

        if (voiceRequestedSize) {
          // ✅ Voice order with size — validate the voice-requested size
          const normalizedVoiceSize = voiceRequestedSize.toUpperCase();
          const isSizeValid = availableSizes.length === 0 || availableSizes.includes(normalizedVoiceSize);

          if (!isSizeValid) {
            // ✅ Voice size not valid — ask customer to pick
            await supabase
              .from("user_sessions")
              .update({ checkout_step: "size", action_step: null })
              .eq("phone_number", phone);

            await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
            const sizeRows = availableSizes.map(s => ({ id: `SIZE_${s}`, title: s }));
            const sizeBody = `📐 *Select Size*\n\nProduct: *${product.product_name}*\n\nThe size we heard ("${voiceRequestedSize}") isn't available for this product.`;
            if (availableSizes.length > 3) {
              twiml.list(sizeBody, "Choose Size", [{ title: "Available Sizes", rows: sizeRows }]);
            } else {
              twiml.buttons(sizeBody, sizeRows);
            }
            return sendTwiml(res, twiml);
          }

          // ✅ Voice size is valid — add directly to cart with voice quantity and size
          const finalSize = normalizedVoiceSize;

          const { data: existingCart } = await supabase
            .from("cart").select("*")
            .eq("phone_number", phone)
            .eq("product_id", productIdToUse)
            .maybeSingle();

          if (existingCart) {
            await supabase.from("cart")
              .update({ quantity: existingCart.quantity + quantityToAdd, size: finalSize })
              .eq("id", existingCart.id);
          } else {
            const { error: insertError } = await supabase
              .from("cart")
              .insert({ phone_number: phone, product_id: productIdToUse, quantity: quantityToAdd, size: finalSize });
            if (insertError) {
              await incrementStoreMessageUsage(activeStoreId, "outgoing");
              twiml.message(`⚠️ Cart error: ${insertError.message}`);
              return sendTwiml(res, twiml);
            }
          }

          // ✅ Clear voice pending from session (it was consumed here).
          // Also clear any stale checkout_step="size" left over from an
          // earlier interaction, so the next CHECKOUT reaches its handler
          // instead of being swallowed by the SIZE STEP guard.
          await supabase.from("user_sessions")
            .update({ checkout_step: null, action_step: "product_action", last_results: null })
            .eq("phone_number", phone);

          const voiceAddedBody =
            `✅ *Added to Cart!*\n\n` +
            `📦 ${product.product_name}\n` +
            `📐 Size: *${finalSize}*\n` +
            `💰 ₹${product.price}\n` +
            `🔢 Qty: ${quantityToAdd}\n\n` +
            `What would you like to do next?`;
          await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
          twiml.buttons(voiceAddedBody, [
            { id: "VIEW_CART", title: "👀 View Cart" },
            { id: "CHECKOUT", title: "✅ Checkout" },
            { id: "CONTINUE_SHOPPING", title: "🔍 Continue" }
          ]);
          return sendTwiml(res, twiml);

        } else {
          // ✅ Normal text order with sizes — existing behavior, now also
          // offered as an interactive size selector.
          await supabase
            .from("user_sessions")
            .update({ checkout_step: "size", action_step: null })
            .eq("phone_number", phone);

          await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
          const sizeRows = availableSizes.map(s => ({ id: `SIZE_${s}`, title: s }));
          const sizeBody = `📐 *Select Size*\n\nProduct: *${product.product_name}*`;
          if (availableSizes.length > 3) {
            twiml.list(sizeBody, "Choose Size", [{ title: "Available Sizes", rows: sizeRows }]);
          } else {
            twiml.buttons(sizeBody, sizeRows);
          }
          return sendTwiml(res, twiml);
        }
      }

      // ✅ No sizes on product — existing cart insert/update behavior exactly unchanged
      const { data: existingCart } = await supabase
        .from("cart").select("*")
        .eq("phone_number", phone)
        .eq("product_id", productIdToUse)
        .maybeSingle();

      if (existingCart) {
        await supabase.from("cart")
          .update({ quantity: existingCart.quantity + quantityToAdd })
          .eq("id", existingCart.id);
      } else {
        const { error: insertError } = await supabase
          .from("cart")
          .insert({ phone_number: phone, product_id: productIdToUse, quantity: quantityToAdd, size: 'Free Size' });
        if (insertError) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
          twiml.message(`⚠️ Cart error: ${insertError.message}`);
          return sendTwiml(res, twiml);
        }
      }

      // ✅ Clear voice pending from session if it was used. Also clear any
      // stale checkout_step="size" left from an earlier interaction so a
      // later CHECKOUT isn't swallowed by the SIZE STEP guard.
      await supabase.from("user_sessions")
        .update({
          checkout_step: null,
          action_step: "product_action",
          last_results: voicePendingMatches ? null : undefined
        })
        .eq("phone_number", phone);

      const freeSizeAddedBody =
        `✅ *Added to Cart!*\n\n` +
        `📦 ${product.product_name}\n` +
        `💰 ₹${product.price}\n` +
        `🔢 Qty: ${quantityToAdd}\n\n` +
        `What would you like to do next?`;
      await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
      twiml.buttons(freeSizeAddedBody, [
        { id: "VIEW_CART", title: "👀 View Cart" },
        { id: "CHECKOUT", title: "✅ Checkout" },
        { id: "CONTINUE_SHOPPING", title: "🔍 Continue" }
      ]);
      return sendTwiml(res, twiml);
    }

    // ✅ 12. CART — top level
    // ✅ Accept both the typed command and its interactive button ID.
    if (msgUpper === "CART" || msgUpper === "VIEW_CART") {
      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        const sent = await sendWhatsAppButtons(phone, `🛒 Your cart is empty.\n\nSearch for products to get started!`, [
          { id: "CONTINUE_SHOPPING", title: "🔍 Start Shopping" }
        ]);
        if (sent) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        } else {
          twiml.message(`🛒 Your cart is empty.\n\nSearch for products and type *ADD* to add them!`);
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        }
        return sendTwiml(res, twiml);
      }

      let reply = `🛒 *Your Cart*\n\n`;
      let total = 0;
      let itemCount = 0;

      for (let i = 0; i < cartItems.length; i++) {
        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", cartItems[i].product_id).maybeSingle();

        if (product) {
          const itemTotal = product.price * cartItems[i].quantity;
          total += itemTotal;
          itemCount++;
          reply += `${itemCount}. *${product.product_name}*\n`;
          reply += `   📐 Size: ${cartItems[i].size || 'Free Size'}\n`;
          reply += `   💰 ₹${product.price} × ${cartItems[i].quantity} = ₹${itemTotal}\n\n`;
        }
      }

      reply += `─────────────────\n`;
      reply += `🧾 *Total: ₹${total}*\n`;
      reply += `📦 ${itemCount} item${itemCount > 1 ? "s" : ""} in cart\n\n`;
      reply += `Ready to checkout?`;

      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.buttons(reply, [
        { id: "CHECKOUT", title: "✅ Checkout" },
        { id: "REMOVE_ITEM", title: "🗑️ Remove Item" },
        { id: "CONTINUE_SHOPPING", title: "🔍 Continue" }
      ]);
      return sendTwiml(res, twiml);
    }

    // ✅ 12a. REMOVE ITEM — show cart as a removable list
    if (msgUpper === "REMOVE_ITEM") {
      const { data: cartItemsForRemoval } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItemsForRemoval || cartItemsForRemoval.length === 0) {
        const sent = await sendWhatsAppButtons(phone, `🛒 Your cart is already empty.`, [
          { id: "CONTINUE_SHOPPING", title: "🔍 Start Shopping" }
        ]);
        if (sent) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        } else {
          twiml.message(`🛒 Your cart is already empty.`);
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        }
        return sendTwiml(res, twiml);
      }

      const rows = [];
      for (const item of cartItemsForRemoval) {
        const { data: product } = await supabase
          .from("products").select("product_name, price")
          .eq("id", item.product_id).maybeSingle();
        if (product) {
          rows.push({
            id: `REMOVE_CART_${item.id}`,
            title: product.product_name.slice(0, 24),
            description: `${item.size || 'Free Size'} · Qty ${item.quantity} · ₹${product.price}`.slice(0, 72)
          });
        }
      }

      if (rows.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Could not load cart items. Please try again.`);
        return sendTwiml(res, twiml);
      }

      const listSent = await sendWhatsAppList(
        phone,
        `🗑️ *Which item would you like to remove?*`,
        "Select Item",
        [{ title: "Cart Items", rows }]
      );
      if (listSent) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
      } else {
        let fallback = `🗑️ Reply with the number of the item to remove:\n\n`;
        cartItemsForRemoval.forEach((item, idx) => { fallback += `${idx + 1}. Cart item ${item.id}\n`; });
        twiml.message(fallback);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        return sendTwiml(res, twiml);
      }
      return;
    }

    // ✅ 12b. REMOVE_CART_<id> — perform the actual removal
    // Store isolation: re-fetch the cart row and verify it belongs to this
    // phone_number before deleting — never trust the client-supplied ID alone.
    if (msgUpper.startsWith("REMOVE_CART_")) {
      const cartIdToRemove = msgUpper.slice("REMOVE_CART_".length);

      const { data: cartRow } = await supabase
        .from("cart").select("*")
        .eq("id", cartIdToRemove)
        .eq("phone_number", phone)
        .maybeSingle();

      if (!cartRow) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Item not found in your cart. It may have already been removed.`);
        return sendTwiml(res, twiml);
      }

      const { error: deleteError } = await supabase
        .from("cart").delete().eq("id", cartRow.id).eq("phone_number", phone);

      if (deleteError) {
        console.error("❌ Failed to remove cart item:", deleteError.message);
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Could not remove item. Please try again.`);
        return sendTwiml(res, twiml);
      }

      const { data: remainingItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!remainingItems || remainingItems.length === 0) {
        const sent = await sendWhatsAppButtons(phone, `✅ Item removed from your cart.\n\n🛒 Your cart is now empty.`, [
          { id: "CONTINUE_SHOPPING", title: "🔍 Start Shopping" }
        ]);
        if (sent) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        } else {
          twiml.message(`✅ Item removed from your cart.\n\n🛒 Your cart is now empty.`);
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        }
        return sendTwiml(res, twiml);
      }

      let updatedReply = `✅ *Item removed from your cart.*\n\n🛒 *Updated Cart*\n\n`;
      let updatedTotal = 0;
      let updatedCount = 0;

      for (const item of remainingItems) {
        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", item.product_id).maybeSingle();
        if (product) {
          const itemTotal = product.price * item.quantity;
          updatedTotal += itemTotal;
          updatedCount++;
          updatedReply += `${updatedCount}. *${product.product_name}*\n`;
          updatedReply += `   📐 Size: ${item.size || 'Free Size'}\n`;
          updatedReply += `   💰 ₹${product.price} × ${item.quantity} = ₹${itemTotal}\n\n`;
        }
      }

      updatedReply += `─────────────────\n`;
      updatedReply += `🧾 *Total: ₹${updatedTotal}*\n`;
      updatedReply += `📦 ${updatedCount} item${updatedCount > 1 ? "s" : ""} in cart\n\n`;
      updatedReply += `Ready to checkout?`;

      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.buttons(updatedReply, [
        { id: "CHECKOUT", title: "✅ Checkout" },
        { id: "REMOVE_ITEM", title: "🗑️ Remove Item" },
        { id: "CONTINUE_SHOPPING", title: "🔍 Continue" }
      ]);
      return sendTwiml(res, twiml);
    }

    // ✅ 13. CHECKOUT — top level
    if (msgUpper === "CHECKOUT") {
      const { data: cartCheck } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartCheck || cartCheck.length === 0) {
        const sent = await sendWhatsAppButtons(phone, `⚠️ Your cart is empty!\n\nSearch for products to get started.`, [
          { id: "CONTINUE_SHOPPING", title: "🔍 Start Shopping" }
        ]);
        if (sent) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        } else {
          twiml.message(`⚠️ Your cart is empty!\n\nSearch for products and type *ADD* to add them first.`);
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
        }
        return sendTwiml(res, twiml);
      }

      let storeId = sessionStoreId;
      if (!storeId) {
        const { data: firstProduct } = await supabase
          .from("products").select("store_id")
          .eq("id", cartCheck[0].product_id).maybeSingle();
        if (firstProduct?.store_id) storeId = firstProduct.store_id;
      }

      const savedAddress = await getSavedAddress(phone, storeId);

      if (savedAddress) {
        await supabase
          .from("user_sessions")
          .update({
            checkout_step: "saved_address_choice",
            action_step: null,
            saved_address_data: JSON.stringify(savedAddress)
          })
          .eq("phone_number", phone);

        const addrBody =
          `📍 *Saved Delivery Address*\n\n` +
          `👤 ${savedAddress.customer_name}\n` +
          `🏠 ${savedAddress.address}`;
        const sent = await sendWhatsAppButtons(phone, addrBody, [
          { id: "USE_SAVED_ADDRESS", title: "📍 Use Saved" },
          { id: "ADD_NEW_ADDRESS", title: "🏠 New Address" }
        ]);
        if (sent) {
          await incrementStoreMessageUsage(storeId, "outgoing");
        } else {
          twiml.message(
            addrBody + `\n\nReply:\n*1* — Use Saved Address\n*2* — Add New Address`
          );
          await incrementStoreMessageUsage(storeId, "outgoing");
          return sendTwiml(res, twiml);
        }
        return;
      }

      await supabase
        .from("user_sessions")
        .update({ checkout_step: "name_phone", action_step: null })
        .eq("phone_number", phone);

      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.message(
        `🛍️ *Checkout* — ${cartCheck.length} item${cartCheck.length > 1 ? "s" : ""} in your cart.\n\n` +
        `👤 Please send your *name and phone number* together.\n\n` +
        `Example: *Vijay 1234567890*`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 14. ACTION STEP
    if (session?.action_step === "product_action") {
      if (msgUpper === "ADD") {
        if (!session?.selected_product_id) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
          twiml.message(`⚠️ Please search and select a product first!`);
          await supabase.from("user_sessions").update({ action_step: null }).eq("phone_number", phone);
          return sendTwiml(res, twiml);
        }

        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", session.selected_product_id).maybeSingle();

        if (!product) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
          twiml.message(`⚠️ Product not found.`);
          return sendTwiml(res, twiml);
        }

        if (product.size && product.size.trim() !== '') {
          await supabase.from("user_sessions")
            .update({ checkout_step: "size", action_step: null })
            .eq("phone_number", phone);

          await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
          twiml.message(
            `📐 *Select Size*\n\n` +
            `Product: *${product.product_name}*\n\n` +
            `Available sizes:\n` +
            product.size.split(',').map(s => `• *${s.trim()}*`).join('\n') +
            `\n\nType your size`
          );
          return sendTwiml(res, twiml);
        }

        const { data: existingCart } = await supabase
          .from("cart").select("*")
          .eq("phone_number", phone)
          .eq("product_id", session.selected_product_id)
          .maybeSingle();

        if (existingCart) {
          await supabase.from("cart").update({ quantity: existingCart.quantity + 1 }).eq("id", existingCart.id);
        } else {
          await supabase.from("cart").insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1,
            size: 'Free Size'
          });
        }

        await supabase.from("user_sessions").update({ action_step: "product_action" }).eq("phone_number", phone);
        const actionStepAddedBody =
          `✅ *Added to Cart!*\n\n` +
          `📦 ${product.product_name}\n` +
          `💰 ₹${product.price}\n\n` +
          `What would you like to do next?`;
        await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
        twiml.buttons(actionStepAddedBody, [
          { id: "VIEW_CART", title: "👀 View Cart" },
          { id: "CHECKOUT", title: "✅ Checkout" },
          { id: "CONTINUE_SHOPPING", title: "🔍 Continue" }
        ]);
        return sendTwiml(res, twiml);
      }

      if (msgUpper === "CART") {
        const { data: cartItems } = await supabase
          .from("cart").select("*").eq("phone_number", phone);

        if (!cartItems || cartItems.length === 0) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
          twiml.message(`🛒 Your cart is empty.\n\nSearch for products and type *ADD*!`);
          return sendTwiml(res, twiml);
        }

        let reply = `🛒 *Your Cart*\n\n`;
        let total = 0;
        let itemCount = 0;

        for (let i = 0; i < cartItems.length; i++) {
          const { data: product } = await supabase
            .from("products").select("*")
            .eq("id", cartItems[i].product_id).maybeSingle();
          if (product) {
            const itemTotal = product.price * cartItems[i].quantity;
            total += itemTotal;
            itemCount++;
            reply += `${itemCount}. *${product.product_name}*\n`;
            reply += `   📐 Size: ${cartItems[i].size || 'Free Size'}\n`;
            reply += `   💰 ₹${product.price} × ${cartItems[i].quantity} = ₹${itemTotal}\n\n`;
          }
        }

        reply += `─────────────────\n🧾 *Total: ₹${total}*\n\nType *CHECKOUT* to place your order`;
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(reply);
        return sendTwiml(res, twiml);
      }

      if (msgUpper === "CHECKOUT") {
        const { data: cartCheck } = await supabase
          .from("cart").select("*").eq("phone_number", phone);

        if (!cartCheck || cartCheck.length === 0) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
          twiml.message(`⚠️ Your cart is empty!`);
          return sendTwiml(res, twiml);
        }

        await supabase.from("user_sessions")
          .update({ checkout_step: "name_phone", action_step: null })
          .eq("phone_number", phone);

        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(
          `🛍️ *Checkout* — ${cartCheck.length} item${cartCheck.length > 1 ? "s" : ""} in your cart.\n\n` +
          `👤 Please send your *name and phone number* together.\n\n` +
          `Example: *Vijay 1234567890*`
        );
        return sendTwiml(res, twiml);
      }
    }

    // ✅ 15a. INTERACTIVE PRODUCT SELECTION (from search-results list)
    // Mirrors the existing NUMBER CHECK validation: re-fetch from Supabase
    // and verify store isolation. Numeric selection (below) remains a
    // working fallback since last_results is unchanged by this addition.
    if (msgUpper.startsWith("PRODUCT_")) {
      const selectedProductId = msgUpper.slice("PRODUCT_".length);

      const { data: freshProduct } = await supabase
        .from("products")
        .select("*")
        .eq("id", selectedProductId)
        .eq("store_id", sessionStoreId)
        .maybeSingle();

      if (!freshProduct) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      await saveSelectedProduct(phone, freshProduct.id);
      await supabase
        .from("user_sessions")
        .update({ action_step: "product_action", last_results: null })
        .eq("phone_number", phone);

      await sendProductMessage(phone, freshProduct, freshProduct.store_id || activeStoreId);
      return;
    }

    // ✅ 15. NUMBER CHECK
    const isNumber = /^[0-9]+$/.test(msg);

    if (isNumber) {
      const selectedIndex = parseInt(msg.trim(), 10) - 1;

      if (!session || !session.last_results) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Session expired. Please search again!`);
        return sendTwiml(res, twiml);
      }

      let lastResults = session.last_results;
      if (typeof lastResults === "string") {
        try { lastResults = JSON.parse(lastResults); } catch (e) { lastResults = []; }
      }

      if (!Array.isArray(lastResults) || lastResults.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Session expired. Please search again!`);
        return sendTwiml(res, twiml);
      }

      if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= lastResults.length) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Invalid selection. Choose between *1* and *${lastResults.length}*`);
        return sendTwiml(res, twiml);
      }

      const sessionProduct = lastResults[selectedIndex];

      if (!sessionProduct || !sessionProduct.id) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Invalid selection. Choose between *1* and *${lastResults.length}*`);
        return sendTwiml(res, twiml);
      }

      const { data: freshProduct } = await supabase
        .from("products")
        .select("*")
        .eq("id", sessionProduct.id)
        .eq("store_id", sessionStoreId)
        .maybeSingle();

      if (!freshProduct) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      await saveSelectedProduct(phone, freshProduct.id);
      await supabase
        .from("user_sessions")
        .update({ action_step: "product_action", last_results: null })
        .eq("phone_number", phone);

      await sendProductMessage(phone, freshProduct, freshProduct.store_id || activeStoreId);
      return;
    }

    // ✅ 15b. CONTINUE SHOPPING (interactive navigation)
    if (msgUpper === "CONTINUE_SHOPPING" || msgUpper === "CONTINUE SHOPPING") {
      await supabase
        .from("user_sessions")
        .update({ action_step: "product_action", checkout_step: null })
        .eq("phone_number", phone);
      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.message(`🔍 What are you looking for?\n\nJust type a product name, category, or color to search.`);
      return sendTwiml(res, twiml);
    }

    // ✅ 16. SEARCH
    console.log(`🔍 Searching: "${msg}" — store_id: ${sessionStoreId || 'none'}`);

    if (!sessionStoreId) {
      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.message(`⚠️ Store not selected. Please enter your store code first.`);
      return sendTwiml(res, twiml);
    }

    let searchQuery = supabase
      .from("products")
      .select("*")
      .eq("store_id", sessionStoreId)
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%,size.ilike.%${msg}%`)
      .order("id", { ascending: false });

    const { data, error } = await searchQuery;

    if (data && data.length > 0) {
      await saveSession(phone, data);

      if (data.length === 1) {
        await supabase.from("user_sessions").update({ action_step: null }).eq("phone_number", phone);
        await saveSelectedProduct(phone, data[0].id);
        await supabase.from("user_sessions").update({ action_step: "product_action" }).eq("phone_number", phone);
        await sendProductMessage(phone, data[0], data[0].store_id || activeStoreId);
        return;
      } else {
        await supabase.from("user_sessions").update({ action_step: "product_action" }).eq("phone_number", phone);

        // ✅ Interactive list as primary UI; numeric reply remains a working
        // fallback via the existing "// ✅ 15. NUMBER CHECK" handler, since
        // last_results (the array) is unchanged by this.
        const rows = data.slice(0, 10).map(product => ({
          id: `PRODUCT_${product.id}`,
          title: product.product_name.slice(0, 24),
          description: `₹${product.price} · ${product.size || 'Free Size'} · ${product.color || ''}`.slice(0, 72)
        }));

        await incrementStoreMessageUsage(sessionStoreId || activeStoreId, "outgoing");
        twiml.list(
          `🛍️ *Products matching "${msg}"*\n\nSelect one from the list, or reply with a number.`,
          "View Products",
          [{ title: "Search Results", rows }]
        );
      }
    } else {
      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.message(`Sorry, no product found for "${msg}". 😔\n\nTry: *Black*, *Jeans*, *XL*`);
    }

    return sendTwiml(res, twiml);

  } catch (error) {
    console.error("❌ Error:", error.stack || error.message);
    try {
      await sendWhatsAppMessage(phone, `⚠️ Something went wrong on our end. Please try again in a moment!`);
    } catch (fallbackErr) {
      console.error("❌ Fallback reply also failed:", fallbackErr.message);
    }
  }
}

async function placeOrder(phone, session, storeId, orderTotal, shopName, paymentMethod, paymentStatus, res, twiml) {
  try {
    // Online Payment flow now creates its `orders` row up front
    // (createPendingOnlineOrder). If this session already has one,
    // placeOrder() must not insert a duplicate — it only sends the
    // existing PAID-confirmation message and clears the cart/session.
    if (paymentMethod === "UPI" && session.pending_online_order_id) {
      await supabase.from("cart").delete().eq("phone_number", phone);
      await supabase
        .from("user_sessions")
        .update({
          checkout_step: null,
          action_step: null,
          applied_coupon_code: null,
          applied_discount_amount: null,
          razorpay_order_id: null,
          pending_online_order_id: null,
          razorpay_payment_link_url: null
        })
        .eq("phone_number", phone);

      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.message(
        `✅ Thanks! We've received your payment confirmation for Order #${session.pending_online_order_id}.\n\n` +
        `⏳ *Payment Status:* Awaiting Verification\n\n` +
        `The store will verify your payment shortly.`
      );
      return sendTwiml(res, twiml);
    }

    const { data: cartItems } = await supabase
      .from("cart").select("*").eq("phone_number", phone);

    if (!cartItems || cartItems.length === 0) {
      twiml.message(`⚠️ Your cart is empty!`);
      return sendTwiml(res, twiml);
    }

    let storeOrderNumber = 1;
    if (storeId) {
      const { count } = await supabase
        .from("orders")
        .select("*", { count: "exact", head: true })
        .eq("store_id", storeId);
      storeOrderNumber = (count || 0) + 1;
    }

    const addressStr = session.customer_address || '';
    const pincodeFromAddress = (addressStr.match(/\b(\d{6})\b/) || [])[1] || null;

    const orderInsertData = {
      phone_number: phone,
      customer_name: session.customer_name,
      customer_phone: session.customer_phone || null,
      customer_address: session.customer_address,
      status: "pending",
      store_id: storeId,
      store_order_number: storeOrderNumber,
      payment_method: paymentMethod,
      payment_status: paymentStatus,
      payment_amount: orderTotal,
      coupon_code: session.applied_coupon_code || null,
      discount_amount: session.applied_discount_amount || 0,
      razorpay_order_id: paymentMethod === "UPI" ? (session.razorpay_order_id || null) : null,
      created_at: new Date().toISOString()
    };

    let order = null;
    let orderError = null;

    const { data: orderWithPincode, error: errorWithPincode } = await supabase
      .from("orders")
      .insert({ ...orderInsertData, customer_pincode: pincodeFromAddress })
      .select()
      .single();

    if (errorWithPincode) {
      console.log("⚠️ customer_pincode column missing in orders — inserting without it");
      const { data: orderWithout, error: errorWithout } = await supabase
        .from("orders")
        .insert(orderInsertData)
        .select()
        .single();
      order = orderWithout;
      orderError = errorWithout;
    } else {
      order = orderWithPincode;
      orderError = null;
    }

    if (orderError || !order) {
      console.error("❌ Order error:", orderError?.message);
      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.message(`⚠️ Could not place order. Please try again!`);
      return sendTwiml(res, twiml);
    }

    let orderSummary = "";
    const orderItemsToInsert = [];

    for (const item of cartItems) {
      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", item.product_id).maybeSingle();

      if (product) {
        const itemTotal = product.price * item.quantity;
        orderSummary += `• ${product.product_name}${item.size ? ` (${item.size})` : ''} × ${item.quantity} = ₹${itemTotal}\n`;

        orderItemsToInsert.push({
          order_id: order.id,
          product_id: item.product_id,
          quantity: item.quantity,
          size: item.size || null,
          product_name: product.product_name,
          price: product.price
        });
      }
    }

    if (orderItemsToInsert.length > 0) {
      const { error: itemsError } = await supabase.from('order_items').insert(orderItemsToInsert);
      if (itemsError) {
        console.error("❌ order_items insert error:", itemsError.message);
      }
    }

    await supabase.from("cart").delete().eq("phone_number", phone);
    await supabase
      .from("user_sessions")
      .update({
        checkout_step: null,
        action_step: null,
        applied_coupon_code: null,
        applied_discount_amount: null,
        razorpay_order_id: null
      })
      .eq("phone_number", phone);

    if (storeId && session.customer_name && session.customer_address) {
      await saveCustomerAddress(phone, storeId, session.customer_name, session.customer_address, pincodeFromAddress);
    }

    let orderMsg = messages.orderPlaced(
      shopName,
      session.customer_name,
      orderSummary,
      orderTotal,
      session.customer_address,
      storeOrderNumber,
      formatDate(new Date().toISOString())
    );

    if (session.applied_coupon_code && session.applied_discount_amount > 0) {
      orderMsg += `\n\n🎟️ *Coupon:* ${session.applied_coupon_code} — Saved ₹${session.applied_discount_amount}`;
    }

    if (paymentMethod === "COD") {
      orderMsg += `\n\n💵 *Payment Method:* Cash on Delivery\n💳 *Payment Status:* Pending`;
    } else if (paymentMethod === "UPI" && paymentStatus === "awaiting_verification") {
      orderMsg +=
        `\n\n📱 *Payment Method:* UPI\n` +
        `⏳ *Payment Status:* Awaiting Verification\n\n` +
        `The store will verify your payment shortly.\n` +
        `Your order will be confirmed once verified.`;
    }

    await incrementStoreMessageUsage(storeId, "outgoing");
    twiml.message(orderMsg);
    await sendTwiml(res, twiml);

    if (paymentMethod === "UPI" && paymentStatus === "awaiting_verification") {
      const { data: storeOwner } = await supabase
        .from("shop_owners")
        .select("phone_number")
        .eq("id", storeId)
        .maybeSingle();

      if (storeOwner?.phone_number) {
        await incrementStoreMessageUsage(storeId, "outgoing");
        await sendWhatsAppMessage(
          storeOwner.phone_number,
          `💳 *UPI Payment — Verify Required*\n\n` +
          `🆔 Order #${storeOrderNumber}\n` +
          `👤 Customer: ${session.customer_name}\n` +
          `📱 Phone: ${session.customer_phone || phone}\n` +
          `💰 Amount: ₹${orderTotal}\n` +
          (session.applied_coupon_code ? `🎟️ Coupon: ${session.applied_coupon_code} (−₹${session.applied_discount_amount})\n` : '') +
          `\nPlease verify payment in your UPI app and update order status in dashboard.`
        );
      }
    }

  } catch (err) {
    console.error("❌ placeOrder error:", err.message);
    twiml.message(`⚠️ Something went wrong. Please try again!`);
    return sendTwiml(res, twiml);
  }
}

app.post("/update-status", async (req, res) => {
  try {
    const { orderId, newStatus } = req.body;

    if (!orderId || !newStatus) {
      return res.status(400).json({ error: "orderId and newStatus required" });
    }

    const allowedStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!allowedStatuses.includes(newStatus)) {
      return res.status(400).json({ error: `Invalid status: ${newStatus}` });
    }

    let currentOrder = null;
    try {
      const { data, error } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .single();

      if (error) {
        console.error("❌ Order fetch failed:", error.message);
        return res.status(404).json({ error: "Order not found" });
      }
      currentOrder = data;
    } catch (fetchErr) {
      console.error("❌ Order fetch exception:", fetchErr.message);
      return res.status(500).json({ error: "Failed to fetch order" });
    }

    if (currentOrder.status === newStatus) {
      console.log(`⚠️ Order ${orderId} already has status: ${newStatus} — skipping update`);
      return res.status(200).json({ success: true, skipped: true });
    }

    try {
      const { error: updateError } = await supabase
        .from("orders")
        .update({ status: newStatus })
        .eq("id", orderId);

      if (updateError) {
        console.error("❌ Status DB update failed:", updateError.message);
        return res.status(500).json({ error: updateError.message });
      }
    } catch (updateErr) {
      console.error("❌ Status update exception:", updateErr.message);
      return res.status(500).json({ error: "Failed to update status" });
    }

    const shopName = await getShopName(currentOrder.store_id);
    const orderNum = currentOrder.store_order_number || currentOrder.id;
    const customerPhone = currentOrder.phone_number;

    try {
      if (newStatus === "confirmed") {
        await incrementStoreMessageUsage(currentOrder.store_id, "outgoing");
        await sendWhatsAppMessage(customerPhone, messages.orderConfirmed(shopName, orderNum));
      } else if (newStatus === "shipped") {
        await incrementStoreMessageUsage(currentOrder.store_id, "outgoing");
        await sendWhatsAppMessage(customerPhone, messages.orderShipped(shopName, orderNum));
      } else if (newStatus === "delivered") {
        await incrementStoreMessageUsage(currentOrder.store_id, "outgoing");
        await sendWhatsAppMessage(customerPhone, messages.orderDelivered(shopName, orderNum));
      } else if (newStatus === "cancelled") {
        await incrementStoreMessageUsage(currentOrder.store_id, "outgoing");
        await sendWhatsAppMessage(customerPhone, messages.orderCancelled(shopName, orderNum));
      }
    } catch (msgErr) {
      console.error("❌ WhatsApp send failed (non-fatal):", msgErr.message);
    }

    console.log(`✅ Order ${orderId} updated: ${currentOrder.status} → ${newStatus}`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("❌ /update-status unexpected error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/send-offer", async (req, res) => {
  try {
    const {
      storeId, title, description, couponCode, imageUrl, audience, customPhones,
      discountType, discountValue, minimumOrderAmount, startDate, endDate
    } = req.body;

    if (!storeId || !title || !description) return res.status(400).json({ error: "storeId, title and description required" });

    const shopName = await getShopName(storeId);
    let customerPhones = [];

    if (audience === 'custom' && customPhones) {
      customerPhones = customPhones;
    } else {
      const { data: orders } = await supabase
        .from("orders").select("phone_number").eq("store_id", storeId);

      const phoneCounts = {};
      orders?.forEach(o => { phoneCounts[o.phone_number] = (phoneCounts[o.phone_number] || 0) + 1; });
      const allPhones = Object.keys(phoneCounts);

      if (audience === 'all') customerPhones = allPhones;
      else if (audience === 'repeat') customerPhones = allPhones.filter(p => phoneCounts[p] > 1);
      else if (audience === 'new') customerPhones = allPhones.filter(p => phoneCounts[p] === 1);
      else if (audience === 'top') {
        const sorted = Object.entries(phoneCounts).sort((a, b) => b[1] - a[1]);
        customerPhones = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.2))).map(([p]) => p);
      }
    }

    if (customerPhones.length === 0) return res.status(200).json({ success: true, sent: 0, message: "No customers found" });

    const lines = [
      `🎁 *Special Offer from ${shopName}!*`,
      "",
      `*${title}*`,
      "",
      description
    ];

    if (couponCode) {
      lines.push("");
      lines.push("🏷️ *Coupon Code: *");
      lines.push("");
      lines.push("```" + couponCode.toUpperCase() + "```");
      lines.push("");
    }

    if (discountType && discountValue) {
      const discountLabel =
        discountType === "percentage"
          ? `${discountValue}% OFF`
          : `₹${discountValue} OFF`;

      lines.push(`💸 Discount: *${discountLabel}*`);
    }

    if (minimumOrderAmount) {
      lines.push(`🛍️ Minimum Order: *₹${minimumOrderAmount}*`);
    }

    if (startDate) {
      lines.push(`📅 Valid From: *${formatDateOnly(startDate)}*`);
    }

    if (endDate) {
      lines.push(`⏰ Valid Until: *${formatDateOnly(endDate)}*`);
    }

    lines.push("");
    lines.push("🛍️ Shop now — just type a product name!");
    lines.push("Happy Shopping! 🎉");

    const offerMessage = lines.join("\n");

    let sentCount = 0;

    for (const phone of customerPhones) {
      const sent = await sendWhatsAppMessage(phone, offerMessage);
      if (sent) {
        sentCount++;
        await incrementStoreMessageUsage(storeId, "outgoing");
      }
    }

    const { data, error } = await supabase
      .from("offers")
      .insert({
        store_id: storeId,
        title,
        description,
        coupon_code: couponCode || null,
        image_url: imageUrl || null,
        audience,
        sent_count: sentCount,
        discount_type: discountType || null,
        discount_value: discountValue || null,
        minimum_order_amount: minimumOrderAmount || null,
        start_date: startDate || null,
        end_date: endDate || null,
        created_at: new Date().toISOString()
      })
      .select();

    console.log("Offer insert data:", data);
    console.log("Offer insert error:", error);

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.status(200).json({ success: true, sent: sentCount, total: customerPhones.length });
  } catch (err) {
    console.error("❌ send-offer error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase.from("products").select("*");
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(200).json({ message: "No products found" });
    res.status(200).json(data);
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.use((req, res) => { res.status(404).send("Route not found"); });
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});