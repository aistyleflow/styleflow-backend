const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ✅ CORS FIX
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
  console.log("📤 Final TwiML:", xml);
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(xml);
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

    // ✅ 1. GREETING
    if (GREETINGS.includes(msgLower)) {
      res.status(200).end();
      await sendWhatsAppMessage(
        phone,
        `👋 Welcome to *StyleFlow*! 🛍️\n\n` +
        `We are your personal fashion assistant.\n\n` +
        `🔍 *How to shop:*\n` +
        `Just type what you are looking for!\n\n` +
        `Examples:\n` +
        `• Type *Black* to see black products\n` +
        `• Type *Jeans* to see all jeans\n\n` +
        `📦 Type *ORDER STATUS* to check latest order\n` +
        `📋 Type *ORDER HISTORY* to see all orders\n\n` +
        `Happy Shopping! 🎉`
      );
      return;
    }

    // ✅ 2. CHECKOUT STEP — NAME
    if (session?.checkout_step === "name") {
      await supabase
        .from("user_sessions")
        .update({ customer_name: msg, checkout_step: "address" })
        .eq("phone_number", phone);
      twiml.message(`✅ Name saved: *${msg}*\n\n📍 Please enter your delivery address:`);
      return sendTwiml(res, twiml);
    }

    // ✅ 2b. CHECKOUT STEP — PINCODE
    if (session?.checkout_step === "pincode") {
      const pincode = msg.trim()
      if (!/^\d{6}$/.test(pincode)) {
        twiml.message(`⚠️ Please enter a valid *6-digit pincode*.\n\nExample: *600001*`);
        return sendTwiml(res, twiml);
      }

      const fullAddress = `${session.customer_address}, ${pincode}`

      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: null })
          .eq("phone_number", phone);
        twiml.message(`⚠️ Your cart is empty!`);
        return sendTwiml(res, twiml);
      }

      let storeId = null;
      const { data: firstProduct } = await supabase
        .from("products").select("store_id")
        .eq("id", cartItems[0].product_id).maybeSingle();
      if (firstProduct?.store_id) storeId = firstProduct.store_id;

      let storeOrderNumber = 1;
      if (storeId) {
        const { count } = await supabase
          .from("orders")
          .select("*", { count: "exact", head: true })
          .eq("store_id", storeId);
        storeOrderNumber = (count || 0) + 1;
        console.log(`🔢 Store ${storeId} — Order number: ${storeOrderNumber}`);
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert({
          phone_number: phone,
          customer_name: session.customer_name,
          customer_address: fullAddress,
          status: "pending",
          store_id: storeId,
          store_order_number: storeOrderNumber,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (orderError || !order) {
        console.error("❌ Order error:", orderError?.message);
        twiml.message(`⚠️ Could not place order. Please try again!`);
        return sendTwiml(res, twiml);
      }

      let orderTotal = 0;
      let orderSummary = "";

      for (const item of cartItems) {
        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", item.product_id).maybeSingle();

        if (product) {
          await supabase.from("order_items").insert({
            order_id: order.id,
            product_id: item.product_id,
            quantity: item.quantity
          });
          const itemTotal = product.price * item.quantity;
          orderTotal += itemTotal;
          orderSummary += `• ${product.product_name}${item.size ? ` (${item.size})` : ''} × ${item.quantity} = ₹${itemTotal}\n`;
        }
      }

      await supabase.from("cart").delete().eq("phone_number", phone);
      await supabase
        .from("user_sessions")
        .update({ checkout_step: null, action_step: null })
        .eq("phone_number", phone);

      twiml.message(
        `✅ *Order Placed Successfully!*\n\n` +
        `🧾 *Order Summary:*\n${orderSummary}\n` +
        `💰 *Total: ₹${orderTotal}*\n\n` +
        `👤 Name: ${session.customer_name}\n` +
        `📍 Address: ${fullAddress}\n\n` +
        `🆔 Order #${storeOrderNumber}\n` +
        `🕐 ${formatDate(new Date().toISOString())}\n\n` +
        `📦 Type *ORDER STATUS* to track your order\n\n` +
        `Thank you for shopping with *StyleFlow*! 🎉`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 3. CHECKOUT STEP — ADDRESS
    if (session?.checkout_step === "address") {
      await supabase
        .from("user_sessions")
        .update({ customer_address: msg, checkout_step: "pincode" })
        .eq("phone_number", phone);

      twiml.message(`✅ Address saved!\n\n📮 Please enter your *6-digit Pincode*:`);
      return sendTwiml(res, twiml);
    }

    // ✅ 4. SIZE STEP
    if (session?.checkout_step === "size") {
      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", session.selected_product_id).maybeSingle();

      if (!product) {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: null })
          .eq("phone_number", phone);
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      const availableSizes = product.size
        ? product.size.split(',').map(s => s.trim().toUpperCase())
        : [];
      const enteredSize = msg.trim().toUpperCase();

      if (availableSizes.length > 0 && !availableSizes.includes(enteredSize)) {
        twiml.message(
          `⚠️ *"${msg}"* is not a valid size.\n\n` +
          `Please choose from: *${product.size}*`
        );
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
          console.error("❌ Cart update error:", updateError.message);
          twiml.message(`⚠️ Cart error: ${updateError.message}`);
          return sendTwiml(res, twiml);
        }

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
        console.log("🛒 Cart insert attempt — phone:", phone, "product_id:", session.selected_product_id, "size:", finalSize);

        const { data: cartData, error: insertError } = await supabase
          .from("cart")
          .insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1,
            size: finalSize
          })
          .select();

        console.log("🛒 Cart insert result — data:", JSON.stringify(cartData), "error:", JSON.stringify(insertError));

        if (insertError) {
          console.error("❌ Cart insert error:", insertError.message);
          twiml.message(`⚠️ Cart error: ${insertError.message}`);
          return sendTwiml(res, twiml);
        }

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

    // ✅ 5. ORDER STATUS
    if (
      msgUpper === "ORDER STATUS" ||
      msgUpper === "STATUS" ||
      msgUpper === "MY ORDER"
    ) {
      console.log("📦 ORDER STATUS for:", phone);

      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("phone_number", phone)
        .order("id", { ascending: false })
        .limit(1)

      if (!orders || orders.length === 0) {
        twiml.message(
          `📦 *No orders found!*\n\n` +
          `You have not placed any orders yet.\n\n` +
          `Search for products to start shopping! 🛍️`
        );
        return sendTwiml(res, twiml);
      }

      const order = orders[0]
      const emoji = getStatusEmoji(order.status)
      const itemsText = await getOrderItems(order.id)

      twiml.message(
        `📦 *Latest Order Status*\n\n` +
        `🆔 Order #${order.store_order_number || order.id}\n` +
        `${emoji} Status: *${order.status.toUpperCase()}*\n\n` +
        `🛍️ *Items:*\n${itemsText}\n\n` +
        `👤 ${order.customer_name || 'N/A'}\n` +
        `📍 ${order.customer_address || 'N/A'}\n` +
        `🕐 ${formatDate(order.created_at)}\n\n` +
        `📋 Type *ORDER HISTORY* to see all orders`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 6. ORDER HISTORY
    if (
      msgUpper === "ORDER HISTORY" ||
      msgUpper === "MY ORDERS" ||
      msgUpper === "HISTORY"
    ) {
      console.log("📋 ORDER HISTORY for:", phone);

      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("phone_number", phone)
        .order("id", { ascending: false })

      if (!orders || orders.length === 0) {
        twiml.message(
          `📋 *No order history found!*\n\n` +
          `You have not placed any orders yet.\n\n` +
          `Search for products to start shopping! 🛍️`
        );
        return sendTwiml(res, twiml);
      }

      res.status(200).end();

      await sendWhatsAppMessage(
        phone,
        `📋 *Your Order History*\n` +
        `(${orders.length} order${orders.length > 1 ? 's' : ''})\n\n` +
        `─────────────────`
      );

      for (let i = 0; i < orders.length; i++) {
        const order = orders[i]
        const emoji = getStatusEmoji(order.status)
        const itemsText = await getOrderItems(order.id)

        await sendWhatsAppMessage(
          phone,
          `🆔 Order #${order.store_order_number || order.id}\n` +
          `${emoji} *${order.status.toUpperCase()}*\n` +
          `🕐 ${formatDate(order.created_at)}\n\n` +
          `🛍️ *Items:*\n${itemsText}\n\n` +
          `👤 ${order.customer_name || 'N/A'}\n` +
          `📍 ${order.customer_address || 'N/A'}\n` +
          `─────────────────`
        );
      }

      await sendWhatsAppMessage(
        phone,
        `📦 Type *ORDER STATUS* to check latest order\n` +
        `🛍️ Search products to continue shopping!`
      );

      return;
    }

    // ✅ 7. ADD — top level
    if (msgUpper === "ADD") {
      console.log("➕ ADD command for:", phone);

      if (!session?.selected_product_id) {
        twiml.message(`⚠️ Please select a product first by searching!`);
        return sendTwiml(res, twiml);
      }

      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", session.selected_product_id).maybeSingle();

      if (!product) {
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      if (product.size && product.size.trim() !== '') {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: "size", action_step: null })
          .eq("phone_number", phone);

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
        const { error: updateError } = await supabase
          .from("cart")
          .update({ quantity: existingCart.quantity + 1 })
          .eq("id", existingCart.id);

        if (updateError) {
          console.error("❌ Cart update error (ADD):", updateError.message);
          twiml.message(`⚠️ Cart error: ${updateError.message}`);
          return sendTwiml(res, twiml);
        }
      } else {
        console.log("🛒 Cart insert attempt (ADD) — phone:", phone, "product_id:", session.selected_product_id);

        const { data: cartData, error: insertError } = await supabase
          .from("cart")
          .insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1,
            size: 'Free Size'
          })
          .select();

        console.log("🛒 Cart insert result (ADD) — data:", JSON.stringify(cartData), "error:", JSON.stringify(insertError));

        if (insertError) {
          console.error("❌ Cart insert error (ADD):", insertError.message);
          twiml.message(`⚠️ Cart error: ${insertError.message}`);
          return sendTwiml(res, twiml);
        }
      }

      await supabase
        .from("user_sessions")
        .update({ action_step: "product_action" })
        .eq("phone_number", phone);

      twiml.message(
        `✅ *Added to Cart!*\n\n` +
        `📦 ${product.product_name}\n` +
        `💰 ₹${product.price}\n\n` +
        `Type *CART* to View Cart\n` +
        `Type *CHECKOUT* to Checkout`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 8. CART — top level
    if (msgUpper === "CART") {
      console.log("🛒 CART command for:", phone);

      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      console.log("🛒 Cart items found:", cartItems?.length || 0);

      if (!cartItems || cartItems.length === 0) {
        twiml.message(
          `🛒 Your cart is empty.\n\n` +
          `Search for products and type *ADD* to add them!`
        );
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

      twiml.message(reply);
      return sendTwiml(res, twiml);
    }

    // ✅ 9. CHECKOUT — top level
    if (msgUpper === "CHECKOUT") {
      console.log("✅ CHECKOUT command for:", phone);

      const { data: cartCheck } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      console.log("✅ Cart items for checkout:", cartCheck?.length || 0);

      if (!cartCheck || cartCheck.length === 0) {
        twiml.message(
          `⚠️ Your cart is empty!\n\n` +
          `Search for products and type *ADD* to add them first.`
        );
        return sendTwiml(res, twiml);
      }

      await supabase
        .from("user_sessions")
        .update({ checkout_step: "name", action_step: null })
        .eq("phone_number", phone);

      twiml.message(
        `🛍️ *Checkout*\n\n` +
        `${cartCheck.length} item${cartCheck.length > 1 ? "s" : ""} in your cart.\n\n` +
        `👤 Please enter your *full name*:`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 10. ACTION STEP
    if (session?.action_step === "product_action") {
      console.log("🎯 Action step — msg:", msg);

      if (msgUpper === "ADD") {
        if (!session?.selected_product_id) {
          twiml.message(`⚠️ Please search and select a product first!`);
          await supabase
            .from("user_sessions")
            .update({ action_step: null })
            .eq("phone_number", phone);
          return sendTwiml(res, twiml);
        }

        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", session.selected_product_id).maybeSingle();

        if (!product) {
          twiml.message(`⚠️ Product not found. Please search again!`);
          return sendTwiml(res, twiml);
        }

        if (product.size && product.size.trim() !== '') {
          await supabase
            .from("user_sessions")
            .update({ checkout_step: "size", action_step: null })
            .eq("phone_number", phone);

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
          await supabase
            .from("cart")
            .update({ quantity: existingCart.quantity + 1 })
            .eq("id", existingCart.id);
        } else {
          await supabase.from("cart").insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1,
            size: 'Free Size'
          });
        }

        await supabase
          .from("user_sessions")
          .update({ action_step: "product_action" })
          .eq("phone_number", phone);

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
        console.log("🛒 View Cart via action_step");

        const { data: cartItems } = await supabase
          .from("cart").select("*").eq("phone_number", phone);

        if (!cartItems || cartItems.length === 0) {
          twiml.message(
            `🛒 Your cart is empty.\n\n` +
            `Search for products and type *ADD* to add them!`
          );
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

        twiml.message(reply);
        return sendTwiml(res, twiml);
      }

      if (msgUpper === "CHECKOUT") {
        console.log("✅ Checkout via action_step");

        const { data: cartCheck } = await supabase
          .from("cart").select("*").eq("phone_number", phone);

        if (!cartCheck || cartCheck.length === 0) {
          twiml.message(
            `⚠️ Your cart is empty!\n\n` +
            `Search for products and type *ADD* to add them first.`
          );
          return sendTwiml(res, twiml);
        }

        await supabase
          .from("user_sessions")
          .update({ checkout_step: "name", action_step: null })
          .eq("phone_number", phone);

        twiml.message(
          `🛍️ *Checkout*\n\n` +
          `${cartCheck.length} item${cartCheck.length > 1 ? "s" : ""} in your cart.\n\n` +
          `👤 Please enter your *full name*:`
        );
        return sendTwiml(res, twiml);
      }
    }

    // ✅ 11. NUMBER CHECK
    const isNumber = /^[0-9]+$/.test(msg);

    if (isNumber) {
      console.log(`🔢 Product selection: ${msg}`);
      const index = parseInt(msg) - 1;

      if (!session || !session.last_results) {
        twiml.message(`⚠️ Session expired. Please search again!`);
        return sendTwiml(res, twiml);
      }

      const sessionProduct = session.last_results[index];

      if (!sessionProduct) {
        twiml.message(`⚠️ Invalid selection. Choose between *1* and *${session.last_results.length}*`);
        return sendTwiml(res, twiml);
      }

      const { data: freshProduct } = await supabase
        .from("products").select("*")
        .eq("product_name", sessionProduct.product_name).maybeSingle();

      if (!freshProduct) {
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      await saveSelectedProduct(phone, freshProduct.id);

      await supabase
        .from("user_sessions")
        .update({ action_step: "product_action" })
        .eq("phone_number", phone);

      await sendProductMessage(twiml, freshProduct);
      return sendTwiml(res, twiml);
    }

    // ✅ 12. SEARCH
    console.log(`🔍 Searching: "${msg}"`);

    const { data, error } = await supabase
      .from("products").select("*")
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`);

    if (data && data.length > 0) {
      await saveSession(phone, data);

      await supabase
        .from("user_sessions")
        .update({ action_step: null })
        .eq("phone_number", phone);

      if (data.length === 1) {
        await saveSelectedProduct(phone, data[0].id);
        await supabase
          .from("user_sessions")
          .update({ action_step: "product_action" })
          .eq("phone_number", phone);
        await sendProductMessage(twiml, data[0]);
      } else {
        let response = `🛍️ *StyleFlow* — Products matching "${msg}":\n\n`;
        data.forEach((product, index) => {
          response += `${index + 1}. *${product.product_name}*\n`;
          response += `   💰 ₹${product.price}\n`;
          response += `   📐 Sizes: ${product.size || 'Free Size'}\n`;
          response += `   🎨 Color: ${product.color}\n`;
          response += product.image_url ? `   🖼️ Image available\n\n` : `\n`;
        });
        response += `_Reply with a number to select!_`;
        twiml.message(response);
      }
    } else {
      twiml.message(
        `Sorry, no product found for "${msg}". 😔\n\n` +
        `Try: *Black*, *Jeans*, *XL*`
      );
    }

    return sendTwiml(res, twiml);

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).end();
  }
});

// ✅ Update order status + send WhatsApp notification
app.post("/update-status", async (req, res) => {
  try {
    const { orderId, newStatus } = req.body;

    if (!orderId || !newStatus) {
      return res.status(400).json({ error: "orderId and newStatus required" });
    }

    const { error: updateError } = await supabase
      .from("orders")
      .update({ status: newStatus })
      .eq("id", orderId);

    if (updateError) {
      console.error("❌ Status update error:", updateError.message);
      return res.status(500).json({ error: updateError.message });
    }

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (!order) return res.status(200).json({ success: true });

    const { data: store } = await supabase
      .from("shop_owners")
      .select("shop_name")
      .eq("id", order.store_id)
      .maybeSingle();

    const shopName = store?.shop_name || "StyleFlow";
    const orderNum = order.store_order_number || order.id;
    const customerPhone = order.phone_number;

    if (newStatus === "confirmed") {
      await sendWhatsAppMessage(customerPhone,
        `✅ *Your order has been confirmed!*\n\n` +
        `🆔 Order #${orderNum}\n\n` +
        `We're preparing your order.\n\n` +
        `Thank you for shopping with *${shopName}*! 🛍️`
      );
    } else if (newStatus === "delivered") {
      await sendWhatsAppMessage(customerPhone,
        `🎉 *Your order has been delivered!*\n\n` +
        `🆔 Order #${orderNum}\n\n` +
        `Thank you for shopping with *${shopName}*!\n\n` +
        `We'd love to serve you again. 😊`
      );
    } else if (newStatus === "cancelled") {
      await sendWhatsAppMessage(customerPhone,
        `❌ *Your order has been cancelled.*\n\n` +
        `🆔 Order #${orderNum}\n\n` +
        `If you have any questions please contact us.\n\n` +
        `Thank you for shopping with *${shopName}*!`
      );
    }
    
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("❌ update-status error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ✅ NEW — Send Offer to customers
app.post("/send-offer", async (req, res) => {
  try {
    const { storeId, title, description, couponCode, imageUrl, audience, customPhones } = req.body;

    if (!storeId || !title || !description) {
      return res.status(400).json({ error: "storeId, title and description required" });
    }

    console.log(`🎁 Sending offer from store ${storeId} to audience: ${audience}`);

    // ✅ Get customers based on audience
    let customerPhones = [];

    if (audience === 'custom' && customPhones) {
      // ✅ Custom selection — use provided phones
      customerPhones = customPhones;

    } else if (audience === 'all') {
      // ✅ All customers — unique phone numbers from orders
      const { data: orders } = await supabase
        .from("orders")
        .select("phone_number")
        .eq("store_id", storeId);

      customerPhones = [...new Set(orders?.map(o => o.phone_number) || [])];

    } else if (audience === 'repeat') {
      // ✅ Repeat customers — ordered more than once
      const { data: orders } = await supabase
        .from("orders")
        .select("phone_number")
        .eq("store_id", storeId);

      const phoneCounts = {};
      orders?.forEach(o => {
        phoneCounts[o.phone_number] = (phoneCounts[o.phone_number] || 0) + 1;
      });
      customerPhones = Object.keys(phoneCounts).filter(p => phoneCounts[p] > 1);

    } else if (audience === 'new') {
      // ✅ New customers — ordered only once
      const { data: orders } = await supabase
        .from("orders")
        .select("phone_number")
        .eq("store_id", storeId);

      const phoneCounts = {};
      orders?.forEach(o => {
        phoneCounts[o.phone_number] = (phoneCounts[o.phone_number] || 0) + 1;
      });
      customerPhones = Object.keys(phoneCounts).filter(p => phoneCounts[p] === 1);

    } else if (audience === 'top') {
      // ✅ Top customers — top 20% by order count
      const { data: orders } = await supabase
        .from("orders")
        .select("phone_number")
        .eq("store_id", storeId);

      const phoneCounts = {};
      orders?.forEach(o => {
        phoneCounts[o.phone_number] = (phoneCounts[o.phone_number] || 0) + 1;
      });

      const sorted = Object.entries(phoneCounts)
        .sort((a, b) => b[1] - a[1]);

      const topCount = Math.max(1, Math.ceil(sorted.length * 0.2));
      customerPhones = sorted.slice(0, topCount).map(([phone]) => phone);
    }

    console.log(`📱 Sending to ${customerPhones.length} customers`);

    if (customerPhones.length === 0) {
      return res.status(200).json({ success: true, sent: 0, message: "No customers found for this audience" });
    }

    // ✅ Build offer message
    let offerMessage =
      `🎁 *Special Offer from StyleFlow!*\n\n` +
      `*${title}*\n\n` +
      `${description}\n`

    if (couponCode) {
      offerMessage += `\n🏷️ Use coupon code: *${couponCode}*\n`
    }

    offerMessage += `\n🛍️ Shop now — just type a product name!\n`
    offerMessage += `Happy Shopping! 🎉`

    // ✅ Send to all customers
    let sentCount = 0;
    for (const phone of customerPhones) {
      const sent = await sendWhatsAppMessage(phone, offerMessage);
      if (sent) sentCount++;
    }

    // ✅ Save offer to Supabase
    await supabase.from("offers").insert({
      store_id: storeId,
      title,
      description,
      coupon_code: couponCode || null,
      image_url: imageUrl || null,
      audience,
      sent_count: sentCount,
      created_at: new Date().toISOString()
    });

    console.log(`✅ Offer sent to ${sentCount}/${customerPhones.length} customers`);

    return res.status(200).json({
      success: true,
      sent: sentCount,
      total: customerPhones.length
    });

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

app.use((req, res) => {
  res.status(404).send("Route not found");
});

app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});