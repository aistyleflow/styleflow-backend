const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");
const messages = require("./helpers/messageTemplates");

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

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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
      .select('quantity, product_id')
      .eq('order_id', orderId)

    if (!orderItems || orderItems.length === 0) return '   No items found'

    let itemsText = ''
    let total = 0

    for (const item of orderItems) {
      const { data: product } = await supabase
        .from('products')
        .select('product_name, price')
        .eq('id', item.product_id)
        .maybeSingle()

      if (product) {
        const itemTotal = product.price * item.quantity
        total += itemTotal
        itemsText += `   • ${product.product_name} × ${item.quantity} = ₹${itemTotal}\n`
      }
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
        saved_address_data: null
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

app.get("/", (req, res) => {
  res.send("StyleFlow is running!");
});

app.get("/whatsapp", (req, res) => {
  const VERIFY_TOKEN = "styleflow_token";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(200).send("WhatsApp webhook is active!");
  }
});

async function isImageAccessible(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch (err) {
    return false;
  }
}

async function sendWhatsAppMessage(to, messageBody) {
  try {
    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: messageBody
    });
    console.log("✅ Message sent — SID:", message.sid);
    return true;
  } catch (err) {
    console.error("❌ REST API send error:", err.message);
    return false;
  }
}

async function sendProductMessage(twiml, product) {
  const message = twiml.message();
  message.body(
    `🛍️ *Product Details*\n\n` +
    `📦 Product: ${product.product_name}\n` +
    `💰 Price: ₹${product.price}\n` +
    `📦 Stock: ${product.stock}\n` +
    `📐 Sizes: ${product.size || 'Free Size'}\n` +
    `🎨 Color: ${product.color}\n\n` +
    `─────────────────\n` +
    `Type *ADD* to 🛒 Add to Cart\n` +
    `Type *CART* to 👀 View Cart\n` +
    `Type *CHECKOUT* to ✅ Checkout\n` +
    `🔍 Or search more products`
  );
  if (product.image_url) {
    const accessible = await isImageAccessible(product.image_url);
    if (accessible) message.media(product.image_url);
  }
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

function sendTwiml(res, twiml) {
  const xml = twiml.toString();
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(xml);
}

function buildPaymentOptionsMessage(paymentSettings, orderTotal, shopName) {
  const codEnabled = paymentSettings?.cod_enabled !== false;
  const upiEnabled = paymentSettings?.upi_enabled !== false;
  const minCod = paymentSettings?.minimum_cod_amount || 0;
  const instructions = paymentSettings?.payment_instructions || '';

  let msg = `💳 *Choose Payment Method*\n\n`;
  msg += `🧾 Order Total: ₹${orderTotal}\n\n`;

  if (!codEnabled && !upiEnabled) {
    return `⚠️ No payment methods are currently available. Please contact *${shopName}*.`;
  }

  if (codEnabled) {
    const codBlocked = minCod > 0 && orderTotal < minCod;
    if (codBlocked) {
      msg += `💵 Cash on Delivery — Minimum order ₹${minCod} required\n\n`;
    } else {
      msg += `💵 *1* — Cash on Delivery (COD)\n\n`;
    }
  }

  if (upiEnabled) {
    msg += `📱 *2* — Pay with UPI\n\n`;
  }

  if (instructions) {
    msg += `ℹ️ ${instructions}\n\n`;
  }

  msg += `_Reply with *1* for COD or *2* for UPI_`;
  return msg;
}

app.post("/whatsapp", async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).end();

    const phone = body.From;
    const msg = body.Body ? body.Body.trim() : "";
    const msgLower = msg.toLowerCase();
    const msgUpper = msg.toUpperCase();

    console.log("=================================");
    console.log("📩 New message received");
    console.log("PHONE:", phone);
    console.log("MESSAGE:", msg);
    console.log("=================================");

    if (!phone || !msg) return res.status(400).end();

    const twiml = new twilio.twiml.MessagingResponse();

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

    // ✅ 1. GREETING
    if (GREETINGS.includes(msgLower)) {
      res.status(200).end();

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
          `👋 Welcome to *${shopName}*! 🛍️\n\nWe are your personal fashion assistant.\n\n🔍 *How to shop:*\nJust type what you are looking for!\n\nExamples:\n• Type *Black* to see black products\n• Type *Jeans* to see all jeans\n\n📦 Type *ORDER STATUS* to check latest order\n📋 Type *ORDER HISTORY* to see all orders\n\nHappy Shopping! 🎉`
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
        res.status(200).end();
        await incrementStoreMessageUsage(storeByCode.id, "outgoing");
        await sendWhatsAppMessage(
          phone,
          `✅ *${storeByCode.shop_name}* store selected!\n\n👋 Welcome! We are your personal fashion assistant.\n\n🔍 *How to shop:*\nJust type what you are looking for!\n\nExamples:\n• Type *Black* to see black products\n• Type *Jeans* to see all jeans\n\n📦 Type *ORDER STATUS* to check latest order\n📋 Type *ORDER HISTORY* to see all orders\n\nHappy Shopping! 🎉`
        );
        return;
      }
    }

    // ✅ 3. CHECKOUT STEP — PAYMENT
    if (session?.checkout_step === "payment") {
      const storeId = session.pending_store_id || sessionStoreId;
      const orderTotal = session.pending_order_total || 0;
      const shopName = await getShopName(storeId);
      const paymentSettings = await getPaymentSettings(storeId);

      const codEnabled = paymentSettings?.cod_enabled !== false;
      const upiEnabled = paymentSettings?.upi_enabled !== false;
      const minCod = paymentSettings?.minimum_cod_amount || 0;

      if (msg === "1" || msgUpper === "COD" || msgUpper === "CASH ON DELIVERY") {
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

      if (msg === "2" || msgUpper === "UPI" || msgUpper === "PAY WITH UPI") {
        if (!upiEnabled) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ UPI payment is not available.\n\nPlease type *1* to use Cash on Delivery.`);
          return sendTwiml(res, twiml);
        }

        const upiId = paymentSettings?.upi_id;
        const qrCodeUrl = paymentSettings?.qr_code_url;
        const instructions = paymentSettings?.payment_instructions;

        console.log("📱 UPI selected — upi_id:", upiId || "NOT SET");
        console.log("📷 qr_code_url:", qrCodeUrl || "NOT SET");

        if (!upiId) {
          await incrementStoreMessageUsage(storeId, "outgoing");
          twiml.message(`⚠️ UPI payment is not configured for this store.\n\nPlease type *1* for Cash on Delivery or contact *${shopName}*.`);
          return sendTwiml(res, twiml);
        }

        await supabase
          .from("user_sessions")
          .update({ checkout_step: "awaiting_payment", payment_method: "UPI" })
          .eq("phone_number", phone);

        let upiMsg =
          `📱 *Pay with UPI*\n\n` +
          `🧾 Amount: *₹${orderTotal}*\n\n` +
          `🏪 Pay to: *${shopName}*\n` +
          `📲 UPI ID: *${upiId}*\n\n`;

        if (instructions) upiMsg += `ℹ️ ${instructions}\n\n`;
        upiMsg += `─────────────────\nAfter paying, type *PAID* to confirm ✅\nOr type *CANCEL* to cancel this order.`;

        await incrementStoreMessageUsage(storeId, "outgoing");
        twiml.message(upiMsg);
        sendTwiml(res, twiml);

        if (qrCodeUrl) {
          const accessible = await isImageAccessible(qrCodeUrl);
          if (accessible) {
            try {
              const qrMessage = await client.messages.create({
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                to: phone,
                body: `📷 *Scan to pay ₹${orderTotal}*\n\nAfter paying, type *PAID* to confirm.`,
                mediaUrl: [qrCodeUrl]
              });
              console.log("✅ QR sent — SID:", qrMessage.sid);
              await incrementStoreMessageUsage(storeId, "outgoing");
            } catch (qrErr) {
              console.error("❌ QR send failed:", qrErr.message);
              await sendWhatsAppMessage(phone, `⚠️ QR code could not be sent.\n\nPlease pay to UPI ID: *${upiId}*\n\nAfter paying, type *PAID* to confirm.`);
              await incrementStoreMessageUsage(storeId, "outgoing");
            }
          } else {
            await sendWhatsAppMessage(phone, `⚠️ QR code could not be loaded.\n\nPlease pay to UPI ID: *${upiId}*\n\nAfter paying, type *PAID* to confirm.`);
            await incrementStoreMessageUsage(storeId, "outgoing");
          }
        }

        return;
      }

      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.message(`⚠️ Invalid selection.\n\n` + buildPaymentOptionsMessage(paymentSettings, orderTotal, shopName));
      return sendTwiml(res, twiml);
    }

    // ✅ 4. CHECKOUT STEP — AWAITING UPI PAYMENT
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

    // ✅ 5. CHECKOUT STEP — NAME + PHONE
    if (session?.checkout_step === "name_phone") {
      console.log("📝 name_phone step:", msg);

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
          `Example:\n*Sanjay 9876543210*\n\n` +
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

    // ✅ 6. CHECKOUT STEP — ADDRESS + PINCODE
    if (session?.checkout_step === "address_pincode") {
      console.log("📍 address_pincode step:", msg);

      const trimmed = msg.trim();
      const pincodeMatch = trimmed.match(/\b(\d{6})\b/);

      if (!pincodeMatch) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `⚠️ Please include a valid *6-digit pincode* in your message.\n\n` +
          `Example:\n*12 Main Street, Chennai 600001*\n\n` +
          `Type your full address followed by your 6-digit pincode.`
        );
        return sendTwiml(res, twiml);
      }

      const pincode = pincodeMatch[1];
      const address = trimmed.replace(pincodeMatch[0], '').replace(/,\s*$/, '').trim();

      if (!address) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `⚠️ Please include your *full address* along with the pincode.\n\n` +
          `Example:\n*12 Main Street, Chennai 600001*`
        );
        return sendTwiml(res, twiml);
      }

      const fullAddress = `${address}, ${pincode}`;

      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        await supabase.from("user_sessions").update({ checkout_step: null }).eq("phone_number", phone);
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(`⚠️ Your cart is empty!`);
        return sendTwiml(res, twiml);
      }

      let storeId = sessionStoreId;
      if (!storeId) {
        const { data: firstProduct } = await supabase
          .from("products").select("store_id")
          .eq("id", cartItems[0].product_id).maybeSingle();
        if (firstProduct?.store_id) storeId = firstProduct.store_id;
      }

      let orderTotal = 0;
      for (const item of cartItems) {
        const { data: product } = await supabase
          .from("products").select("price")
          .eq("id", item.product_id).maybeSingle();
        if (product) orderTotal += product.price * item.quantity;
      }

      const shopName = await getShopName(storeId);
      const paymentSettings = await getPaymentSettings(storeId);

      await supabase
        .from("user_sessions")
        .update({
          customer_address: fullAddress,
          customer_pincode: pincode,
          checkout_step: "payment",
          pending_store_id: storeId,
          pending_order_total: orderTotal
        })
        .eq("phone_number", phone);

      const codEnabled = paymentSettings?.cod_enabled !== false;
      const upiEnabled = paymentSettings?.upi_enabled !== false;

      if (!codEnabled && !upiEnabled) {
        await incrementStoreMessageUsage(storeId, "outgoing");
        twiml.message(`⚠️ No payment methods available.\n\nPlease contact *${shopName}*.`);
        return sendTwiml(res, twiml);
      }

      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.message(buildPaymentOptionsMessage(paymentSettings, orderTotal, shopName));
      return sendTwiml(res, twiml);
    }

    // ✅ 7. CHECKOUT STEP — SAVED ADDRESS CHOICE
    if (session?.checkout_step === "saved_address_choice") {
      if (msg === "1" || msgUpper === "USE SAVED ADDRESS") {
        const savedAddress = session.saved_address_data
          ? JSON.parse(session.saved_address_data)
          : null;

        if (!savedAddress) {
          await supabase.from("user_sessions").update({ checkout_step: "name_phone" }).eq("phone_number", phone);
          await incrementStoreMessageUsage(sessionStoreId, "outgoing");
          twiml.message(
            `⚠️ No saved address found.\n\n` +
            `👤 Please send your *name and phone number* together.\n\n` +
            `Example: *Sanjay 9876543210*`
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

        const shopName = await getShopName(storeId);
        const paymentSettings = await getPaymentSettings(storeId);

        await supabase
          .from("user_sessions")
          .update({
            customer_name: savedAddress.customer_name,
            customer_address: savedAddress.address,
            checkout_step: "payment",
            pending_store_id: storeId,
            pending_order_total: orderTotal
          })
          .eq("phone_number", phone);

        await incrementStoreMessageUsage(storeId, "outgoing");
        twiml.message(buildPaymentOptionsMessage(paymentSettings, orderTotal, shopName));
        return sendTwiml(res, twiml);
      }

      if (msg === "2" || msgUpper === "ADD NEW ADDRESS" || msgUpper === "NEW ADDRESS") {
        await supabase.from("user_sessions").update({ checkout_step: "name_phone" }).eq("phone_number", phone);
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `👤 Please send your *name and phone number* together.\n\n` +
          `Example: *Sanjay 9876543210*`
        );
        return sendTwiml(res, twiml);
      }

      await incrementStoreMessageUsage(sessionStoreId, "outgoing");
      twiml.message(`⚠️ Please reply:\n\n*1* — Use Saved Address\n*2* — Add New Address`);
      return sendTwiml(res, twiml);
    }

    // ✅ 8. SIZE STEP
    if (session?.checkout_step === "size") {
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
      const enteredSize = msg.trim().toUpperCase();

      if (availableSizes.length > 0 && !availableSizes.includes(enteredSize)) {
        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(`⚠️ *"${msg}"* is not a valid size.\n\nPlease choose from: *${product.size}*`);
        return sendTwiml(res, twiml);
      }

      const finalSize = availableSizes.length > 0 ? enteredSize : msg.trim();

      const { data: existingCart } = await supabase
        .from("cart").select("*")
        .eq("phone_number", phone)
        .eq("product_id", session.selected_product_id)
        .maybeSingle();

      if (existingCart) {
        const { error: updateError } = await supabase
          .from("cart")
          .update({ quantity: existingCart.quantity + 1, size: finalSize })
          .eq("id", existingCart.id);

        if (updateError) {
          await incrementStoreMessageUsage(sessionStoreId, "outgoing");
          twiml.message(`⚠️ Cart error: ${updateError.message}`);
          return sendTwiml(res, twiml);
        }

        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `✅ *Cart Updated!*\n\n` +
          `📦 ${product.product_name}\n` +
          `📐 Size: *${finalSize}*\n` +
          `💰 ₹${product.price}\n` +
          `🔢 Qty: ${existingCart.quantity + 1}\n\n` +
          `Type *CART* to View Cart\n` +
          `Type *CHECKOUT* to Checkout`
        );
      } else {
        const { error: insertError } = await supabase
          .from("cart")
          .insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1,
            size: finalSize
          });

        if (insertError) {
          await incrementStoreMessageUsage(sessionStoreId, "outgoing");
          twiml.message(`⚠️ Cart error: ${insertError.message}`);
          return sendTwiml(res, twiml);
        }

        await incrementStoreMessageUsage(sessionStoreId, "outgoing");
        twiml.message(
          `✅ *Added to Cart!*\n\n` +
          `📦 ${product.product_name}\n` +
          `📐 Size: *${finalSize}*\n` +
          `💰 ₹${product.price}\n\n` +
          `Type *CART* to View Cart\n` +
          `Type *CHECKOUT* to Checkout`
        );
      }

      await supabase
        .from("user_sessions")
        .update({ checkout_step: null, action_step: "product_action" })
        .eq("phone_number", phone);

      return sendTwiml(res, twiml);
    }

    // ✅ 9. ORDER STATUS
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
        `🕐 ${formatDate(order.created_at)}\n\n` +
        `📋 Type *ORDER HISTORY* to see all orders`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 10. ORDER HISTORY
    if (msgUpper === "ORDER HISTORY" || msgUpper === "MY ORDERS" || msgUpper === "HISTORY") {
      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("phone_number", phone)
        .order("id", { ascending: false });

      if (!orders || orders.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`📋 *No order history found!*\n\nYou have not placed any orders yet.\n\nSearch for products to start shopping! 🛍️`);
        return sendTwiml(res, twiml);
      }

      const deliveredOrders = orders.filter(
        o => o.status && o.status.toLowerCase() === "delivered"
      );

      const totalSpent = deliveredOrders.reduce(
        (sum, o) =>
          sum + Number(o.payment_amount || o.total_amount || o.order_total || o.total || 0),
        0
      );

      console.log("📦 Delivered orders for history:", deliveredOrders.map(o => ({
        id: o.id,
        status: o.status,
        payment_amount: o.payment_amount,
        total_amount: o.total_amount,
        order_total: o.order_total,
        total: o.total
      })));

      res.status(200).end();

      const historyStoreId = orders[0]?.store_id || activeStoreId;

      await incrementStoreMessageUsage(historyStoreId, "outgoing");
      await sendWhatsAppMessage(
        phone,
        `📋 *Your Order History*\n(${orders.length} order${orders.length > 1 ? 's' : ''})\n\n` +
        `💰 *Total Spent: ₹${totalSpent}*\n_(from ${deliveredOrders.length} delivered order${deliveredOrders.length !== 1 ? 's' : ''})_\n\n` +
        `─────────────────`
      );

      for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        const emoji = getStatusEmoji(order.status);
        const itemsText = await getOrderItems(order.id);

        await incrementStoreMessageUsage(order.store_id || historyStoreId, "outgoing");
        await sendWhatsAppMessage(
          phone,
          `🆔 Order #${order.store_order_number || order.id}\n` +
          `${emoji} *${order.status.toUpperCase()}*\n` +
          `💳 Payment: *${order.payment_method || 'N/A'}* — ${order.payment_status || 'N/A'}\n` +
          `🕐 ${formatDate(order.created_at)}\n\n` +
          `🛍️ *Items:*\n${itemsText}\n\n` +
          `👤 ${order.customer_name || 'N/A'}\n` +
          `📍 ${order.customer_address || 'N/A'}\n` +
          `─────────────────`
        );
      }

      await incrementStoreMessageUsage(historyStoreId, "outgoing");
      await sendWhatsAppMessage(
        phone,
        `📦 Type *ORDER STATUS* to check latest order\n🛍️ Search products to continue shopping!`
      );

      return;
    }

    // ✅ 11. ADD — top level
    if (msgUpper === "ADD") {
      if (!session?.selected_product_id) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Please select a product first by searching!`);
        return sendTwiml(res, twiml);
      }

      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", session.selected_product_id).maybeSingle();

      if (!product) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      if (product.size && product.size.trim() !== '') {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: "size", action_step: null })
          .eq("phone_number", phone);

        await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
        twiml.message(
          `📐 *Select Size*\n\n` +
          `Product: *${product.product_name}*\n\n` +
          `Available sizes:\n` +
          product.size.split(',').map(s => `• *${s.trim()}*`).join('\n') +
          `\n\nType your size (e.g. *M* or *XL*)`
        );
        return sendTwiml(res, twiml);
      }

      const { data: existingCart } = await supabase
        .from("cart").select("*")
        .eq("phone_number", phone)
        .eq("product_id", session.selected_product_id)
        .maybeSingle();

      if (existingCart) {
        await supabase.from("cart")
          .update({ quantity: existingCart.quantity + 1 })
          .eq("id", existingCart.id);
      } else {
        const { error: insertError } = await supabase
          .from("cart")
          .insert({ phone_number: phone, product_id: session.selected_product_id, quantity: 1, size: 'Free Size' });
        if (insertError) {
          await incrementStoreMessageUsage(activeStoreId, "outgoing");
          twiml.message(`⚠️ Cart error: ${insertError.message}`);
          return sendTwiml(res, twiml);
        }
      }

      await supabase.from("user_sessions").update({ action_step: "product_action" }).eq("phone_number", phone);
      await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
      twiml.message(
        `✅ *Added to Cart!*\n\n` +
        `📦 ${product.product_name}\n` +
        `💰 ₹${product.price}\n\n` +
        `Type *CART* to View Cart\n` +
        `Type *CHECKOUT* to Checkout`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 12. CART — top level
    if (msgUpper === "CART") {
      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`🛒 Your cart is empty.\n\nSearch for products and type *ADD* to add them!`);
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
      reply += `Type *CHECKOUT* to place your order\n`;
      reply += `🔍 Or search for more products!`;

      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.message(reply);
      return sendTwiml(res, twiml);
    }

    // ✅ 13. CHECKOUT — top level
    if (msgUpper === "CHECKOUT") {
      const { data: cartCheck } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartCheck || cartCheck.length === 0) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Your cart is empty!\n\nSearch for products and type *ADD* to add them first.`);
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

        await incrementStoreMessageUsage(storeId, "outgoing");
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

      await supabase
        .from("user_sessions")
        .update({ checkout_step: "name_phone", action_step: null })
        .eq("phone_number", phone);

      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.message(
        `🛍️ *Checkout* — ${cartCheck.length} item${cartCheck.length > 1 ? "s" : ""} in your cart.\n\n` +
        `👤 Please send your *name and phone number* together.\n\n` +
        `Example: *Sanjay 9876543210*`
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
        await incrementStoreMessageUsage(product.store_id || activeStoreId, "outgoing");
        twiml.message(
          `✅ *Added to Cart!*\n\n` +
          `📦 ${product.product_name}\n` +
          `💰 ₹${product.price}\n\n` +
          `Type *CART* to View Cart\n` +
          `Type *CHECKOUT* to Checkout`
        );
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
          `Example: *Sanjay 9876543210*`
        );
        return sendTwiml(res, twiml);
      }
    }

    // ✅ 15. NUMBER CHECK
    const isNumber = /^[0-9]+$/.test(msg);

    if (isNumber) {
      const index = parseInt(msg) - 1;

      if (!session || !session.last_results) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Session expired. Please search again!`);
        return sendTwiml(res, twiml);
      }

      const sessionProduct = session.last_results[index];

      if (!sessionProduct) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Invalid selection. Choose between *1* and *${session.last_results.length}*`);
        return sendTwiml(res, twiml);
      }

      const { data: freshProduct } = await supabase
        .from("products").select("*")
        .eq("product_name", sessionProduct.product_name).maybeSingle();

      if (!freshProduct) {
        await incrementStoreMessageUsage(activeStoreId, "outgoing");
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      await saveSelectedProduct(phone, freshProduct.id);
      await supabase.from("user_sessions")
        .update({ action_step: "product_action" })
        .eq("phone_number", phone);

      await incrementStoreMessageUsage(freshProduct.store_id || activeStoreId, "outgoing");
      await sendProductMessage(twiml, freshProduct);
      return sendTwiml(res, twiml);
    }

    // ✅ 16. SEARCH — Fix 3: no stock filter, correct store filter for new products
    console.log(`🔍 Searching: "${msg}" — store_id: ${sessionStoreId || 'all'}`);

    let searchQuery = supabase
      .from("products")
      .select("*")
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`);

    // ✅ Filter by store only — no stock filter so new products always appear
    if (sessionStoreId) {
      searchQuery = searchQuery.eq("store_id", sessionStoreId);
    }

    const { data, error } = await searchQuery;

    if (data && data.length > 0) {
      await saveSession(phone, data);
      await supabase.from("user_sessions").update({ action_step: null }).eq("phone_number", phone);

      if (data.length === 1) {
        await saveSelectedProduct(phone, data[0].id);
        await supabase.from("user_sessions").update({ action_step: "product_action" }).eq("phone_number", phone);
        await incrementStoreMessageUsage(data[0].store_id || activeStoreId, "outgoing");
        await sendProductMessage(twiml, data[0]);
      } else {
        let response = `🛍️ *Products matching "${msg}"*:\n\n`;
        data.forEach((product, index) => {
          response += `${index + 1}. *${product.product_name}*\n`;
          response += `   💰 ₹${product.price}\n`;
          response += `   📐 Sizes: ${product.size || 'Free Size'}\n`;
          response += `   🎨 Color: ${product.color}\n`;
          response += product.image_url ? `   🖼️ Image available\n\n` : `\n`;
        });
        response += `_Reply with a number to select!_`;
        await incrementStoreMessageUsage(sessionStoreId || activeStoreId, "outgoing");
        twiml.message(response);
      }
    } else {
      await incrementStoreMessageUsage(activeStoreId, "outgoing");
      twiml.message(`Sorry, no product found for "${msg}". 😔\n\nTry: *Black*, *Jeans*, *XL*`);
    }

    return sendTwiml(res, twiml);

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).end();
  }
});

// ✅ Shared order placement — Fix 2: size saved in order_items
async function placeOrder(phone, session, storeId, orderTotal, shopName, paymentMethod, paymentStatus, res, twiml) {
  try {
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
    const pincodeFromAddress = session.customer_pincode || (addressStr.match(/\b(\d{6})\b/) || [])[1] || null;

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        phone_number: phone,
        customer_name: session.customer_name,
        customer_phone: session.customer_phone || null,
        customer_address: session.customer_address,
        customer_pincode: pincodeFromAddress,
        status: "pending",
        store_id: storeId,
        store_order_number: storeOrderNumber,
        payment_method: paymentMethod,
        payment_status: paymentStatus,
        payment_amount: orderTotal,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (orderError || !order) {
      console.error("❌ Order error:", orderError?.message);
      await incrementStoreMessageUsage(storeId, "outgoing");
      twiml.message(`⚠️ Could not place order. Please try again!`);
      return sendTwiml(res, twiml);
    }

    let orderSummary = "";

    for (const item of cartItems) {
      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", item.product_id).maybeSingle();

      if (product) {
        // ✅ Fix 2 — save size into order_items
        await supabase.from('order_items').insert(
          cart.map(item => ({
            order_id: orderData.id,
            product_id: item.product_id,
            quantity: item.quantity,
            size: item.size || null,
            product_name: item.product_name,
            price: item.price
          }))
        )
        const itemTotal = product.price * item.quantity;
        orderSummary += `• ${product.product_name}${item.size ? ` (${item.size})` : ''} × ${item.quantity} = ₹${itemTotal}\n`;
      }
    }

    await supabase.from("cart").delete().eq("phone_number", phone);
    await supabase
      .from("user_sessions")
      .update({ checkout_step: null, action_step: null })
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
    sendTwiml(res, twiml);

    if (paymentMethod === "UPI" && paymentStatus === "awaiting_verification") {
      const { data: storeOwner } = await supabase
        .from("shop_owners")
        .select("phone_number")
        .eq("id", storeId)
        .maybeSingle();

      if (storeOwner?.phone_number) {
        await incrementStoreMessageUsage(storeId, "outgoing");
        await sendWhatsAppMessage(
          `whatsapp:${storeOwner.phone_number}`,
          `💳 *UPI Payment — Verify Required*\n\n` +
          `🆔 Order #${storeOrderNumber}\n` +
          `👤 Customer: ${session.customer_name}\n` +
          `📱 Phone: ${session.customer_phone || phone}\n` +
          `💰 Amount: ₹${orderTotal}\n\n` +
          `Please verify payment in your UPI app and update order status in dashboard.`
        );
      }
    }

  } catch (err) {
    console.error("❌ placeOrder error:", err.message);
    twiml.message(`⚠️ Something went wrong. Please try again!`);
    return sendTwiml(res, twiml);
  }
}

// ✅ Fix 1 — /update-status: fixed 500, same-status protection, proper try/catch
app.post("/update-status", async (req, res) => {
  try {
    const { orderId, newStatus } = req.body;

    // ✅ Validate inputs
    if (!orderId || !newStatus) {
      return res.status(400).json({ error: "orderId and newStatus required" });
    }

    const allowedStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!allowedStatuses.includes(newStatus)) {
      return res.status(400).json({ error: `Invalid status: ${newStatus}` });
    }

    // ✅ Fetch current order first
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

    // ✅ Same-status protection — return immediately without sending message
    if (currentOrder.status === newStatus) {
      console.log(`⚠️ Order ${orderId} already has status: ${newStatus} — skipping update`);
      return res.status(200).json({ success: true, skipped: true });
    }

    // ✅ Update order status in DB
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

    // ✅ Send WhatsApp notification — only once, only for new status
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
      // ✅ pending — no message needed
    } catch (msgErr) {
      // ✅ WhatsApp failure should NOT fail the whole route
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
    const { storeId, title, description, couponCode, imageUrl, audience, customPhones } = req.body;
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

    const offerMessage = messages.offerMessage(shopName, title, description, couponCode);
    let sentCount = 0;

    for (const phone of customerPhones) {
      const sent = await sendWhatsAppMessage(phone, offerMessage);
      if (sent) {
        sentCount++;
        await incrementStoreMessageUsage(storeId, "outgoing");
      }
    }

    await supabase.from("offers").insert({
      store_id: storeId, title, description,
      coupon_code: couponCode || null, image_url: imageUrl || null,
      audience, sent_count: sentCount, created_at: new Date().toISOString()
    });

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