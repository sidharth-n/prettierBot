const { Client } = require("@libsql/client")

const client = new Client({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const conversationHistory = {}

module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      console.log("Received POST request:", JSON.stringify(req.body))

      const message = req.body.message
      const callbackQuery = req.body.callback_query

      if (message || callbackQuery) {
        const chatId = message ? message.chat.id : callbackQuery.message.chat.id
        console.log(`Processing request for chat ID: ${chatId}`)

        const fetch = (await import("node-fetch")).default

        // Initialize conversation history for this chat if it doesn't exist
        if (!conversationHistory[chatId]) {
          conversationHistory[chatId] = []
        }

        if (message && message.text) {
          const userText = message.text
          console.log(`Received message: ${userText} (${chatId})`)

          if (userText === "/start") {
            await sendIntroduction(chatId, fetch)
            await configureBot(chatId, fetch)
          } else if (userText === "/config") {
            await configureBot(chatId, fetch)
          } else if (userText === "/help") {
            await sendHelpMessage(chatId, fetch)
          } else {
            conversationHistory[chatId].push({
              role: "user",
              content: userText,
            })

            const userConfig = await getUserConfig(chatId)
            await sendOptionsKeyboard(chatId, userText, fetch, userConfig)
          }
        } else if (callbackQuery) {
          await handleCallbackQuery(chatId, callbackQuery, fetch)
        }

        res.status(200).send("OK")
      } else {
        console.log("No message or callback query found")
        res.status(200).send("No message or callback query found")
      }
    } else {
      console.log(`Received ${req.method} request`)
      res.status(200).send("Hello World")
    }
  } catch (error) {
    console.error("Unhandled error:", error)
    res.status(500).send("Internal Server Error")
  }
}

async function sendIntroduction(chatId, fetch) {
  const introText =
    "Welcome to Prettier Bot! 👋\n\n" +
    "This bot is here to help you simplify your writings. " +
    "Just copy-paste or type your text here, and I'll help you work on it before you send it to somebody else.\n\n" +
    "Let's start by configuring your bot preferences."

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: introText,
      }),
    }
  )
}

async function configureBot(chatId, fetch) {
  const configText =
    "Configure your commands. Select the options you'd like to use:\n\n" +
    "Selecting a single option will keep it as the default option."

  const options = [
    { text: "Correct Grammar", callback_data: "config_correct" },
    { text: "Make Shorter", callback_data: "config_shorter" },
    { text: "Make Longer", callback_data: "config_longer" },
    { text: "Create Variation", callback_data: "config_variation" },
    { text: "Add Emojis", callback_data: "config_emojis" },
    { text: "Format for WhatsApp", callback_data: "config_whatsapp" },
    { text: "Format for X", callback_data: "config_x" },
    { text: "Format for Telegram", callback_data: "config_telegram" },
    { text: "Finish Configuration", callback_data: "config_finish" },
  ]

  const inlineKeyboard = options.map(option => [option])

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: configText,
        reply_markup: {
          inline_keyboard: inlineKeyboard,
        },
      }),
    }
  )
}

async function sendHelpMessage(chatId, fetch) {
  const helpText =
    "Here are the available commands:\n\n" +
    "/start - Start the bot and configure your preferences\n" +
    "/config - Reconfigure your bot preferences\n" +
    "/help - Show this help message\n\n" +
    "To use the bot, simply send your text and choose an option from the provided buttons."

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: helpText,
      }),
    }
  )
}

async function sendOptionsKeyboard(chatId, text, fetch, userConfig) {
  const options = userConfig.map(option => {
    const optionText = option.charAt(0).toUpperCase() + option.slice(1)
    return [{ text: optionText, callback_data: option }]
  })

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        reply_markup: {
          inline_keyboard: options,
        },
      }),
    }
  )
}

async function handleCallbackQuery(chatId, callbackQuery, fetch) {
  const data = callbackQuery.data
  const messageId = callbackQuery.message.message_id
  const originalText = callbackQuery.message.text

  if (data.startsWith("config_")) {
    await handleConfigCallback(chatId, data, fetch)
    return
  }

  let prompt = ""
  switch (data) {
    case "correct":
      prompt =
        "Just correct the grammar and spelling of the following and return: "
      break
    case "shorter":
      prompt =
        "Make the following text shorter by 20% without changing its main meaning: "
      break
    case "longer":
      prompt =
        "Make the following text longer by 20% without changing its main meaning: "
      break
    case "variation":
      prompt = "Create a variation of the following text with similar length: "
      break
    case "emojis":
      prompt = "Add appropriate emojis to the following text: "
      break
    case "whatsapp":
      prompt =
        "Format the following text for WhatsApp (add appropriate line breaks, emojis, etc.): "
      break
    case "x":
      prompt =
        "Format the following text for X (Twitter) (consider character limit, hashtags, etc.): "
      break
    case "telegram":
      prompt =
        "Format the following text for Telegram (consider formatting options like bold, italic, etc.): "
      break
  }

  const gptResponse = await getGPTResponse(chatId, prompt + originalText, fetch)
  await editMessage(chatId, messageId, gptResponse, fetch)

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQuery.id,
      }),
    }
  )
}

async function handleConfigCallback(chatId, data, fetch) {
  if (data === "config_finish") {
    await saveUserConfig(chatId)
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Configuration complete. You can now use the bot with your selected options.",
        }),
      }
    )
  } else {
    const option = data.replace("config_", "")
    await toggleUserConfig(chatId, option)
  }
}

async function getUserConfig(chatId) {
  const result = await client.execute({
    sql: "SELECT config FROM user_configs WHERE chat_id = ?",
    args: [chatId],
  })

  if (result.rows.length > 0) {
    return JSON.parse(result.rows[0].config)
  }
  return [
    "correct",
    "shorter",
    "longer",
    "variation",
    "emojis",
    "whatsapp",
    "x",
    "telegram",
  ]
}

async function toggleUserConfig(chatId, option) {
  let config = await getUserConfig(chatId)
  const index = config.indexOf(option)
  if (index > -1) {
    config.splice(index, 1)
  } else {
    config.push(option)
  }
  await client.execute({
    sql: "INSERT OR REPLACE INTO user_configs (chat_id, config) VALUES (?, ?)",
    args: [chatId, JSON.stringify(config)],
  })
}

async function saveUserConfig(chatId) {
  const config = await getUserConfig(chatId)
  await client.execute({
    sql: "INSERT OR REPLACE INTO user_configs (chat_id, config) VALUES (?, ?)",
    args: [chatId, JSON.stringify(config)],
  })
}

async function editMessage(chatId, messageId, text, fetch) {
  const userConfig = await getUserConfig(chatId)
  const options = userConfig.map(option => {
    const optionText = option.charAt(0).toUpperCase() + option.slice(1)
    return [{ text: optionText, callback_data: option }]
  })

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        reply_markup: {
          inline_keyboard: options,
        },
      }),
    }
  )
}

async function getGPTResponse(chatId, prompt, fetch) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPEN_AI_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4-0613",
      messages: [
        {
          role: "system",
          content:
            "You are Prettier, a Telegram bot designed to help users improve and modify their text.",
        },
        ...conversationHistory[chatId].slice(-5),
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    }),
  })

  const data = await response.json()
  const botResponse = data.choices[0].message.content
  conversationHistory[chatId].push({ role: "assistant", content: botResponse })
  return botResponse
}
