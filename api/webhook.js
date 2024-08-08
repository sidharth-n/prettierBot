const { createClient } = require("@libsql/client")

const client = createClient({
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
          // Handle text
          const userText = message.text
          console.log(`Received message: ${userText} (${chatId})`)

          // Ensure user exists in the database
          await ensureUser(chatId, message.from)

          if (userText === "/start") {
            // Handle /start command
            await sendIntroduction(chatId, fetch)
            await startConfiguration(chatId, fetch)
          } else if (userText === "/config") {
            // Handle /config command
            await startConfiguration(chatId, fetch)
          } else {
            // Save user message in conversation history
            conversationHistory[chatId].push({
              role: "user",
              content: userText,
            })

            const userConfig = await getUserConfig(chatId)
            await sendOptionsKeyboard(chatId, userText, fetch, userConfig)
          }
        } else if (callbackQuery) {
          // Handle button clicks
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

async function ensureUser(chatId, userInfo) {
  try {
    const { result } = await client.execute({
      sql: `INSERT INTO users (chat_id, username, first_name, last_name) 
            VALUES (?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
            username = excluded.username,
            first_name = excluded.first_name,
            last_name = excluded.last_name`,
      args: [
        chatId,
        userInfo.username,
        userInfo.first_name,
        userInfo.last_name,
      ],
    })
    console.log(`User ensured: ${chatId}`)
  } catch (error) {
    console.error(`Error ensuring user: ${error.message}`)
  }
}

async function getUserConfig(chatId) {
  try {
    const { rows } = await client.execute({
      sql: "SELECT config FROM user_configs WHERE chat_id = ?",
      args: [chatId],
    })
    return rows.length > 0
      ? JSON.parse(rows[0].config)
      : ["correct", "shorter", "longer", "variation", "emojis"]
  } catch (error) {
    console.error(`Error getting user config: ${error.message}`)
    return ["correct", "shorter", "longer", "variation", "emojis"]
  }
}

async function saveUserConfig(chatId, config) {
  try {
    await client.execute({
      sql: "INSERT OR REPLACE INTO user_configs (chat_id, config) VALUES (?, ?)",
      args: [chatId, JSON.stringify(config)],
    })
  } catch (error) {
    console.error(`Error saving user config: ${error.message}`)
  }
}

async function sendIntroduction(chatId, fetch) {
  const introText =
    "Welcome to Prettier Bot! 👋\n\n" +
    "This bot is here to help you simplify your writings. " +
    "Just copy-paste or type your text here, and I'll help you work on it before you send it to somebody else.\n\n" +
    "Let's start by configuring your preferences."

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

async function startConfiguration(chatId, fetch) {
  const configText =
    "Configure your commands. Select the options you'd like to use:\n\n" +
    "Selecting a single option will keep it as the default option."

  const options = [
    { text: "Correct Grammar", callback_data: "config_correct" },
    { text: "Make Shorter", callback_data: "config_shorter" },
    { text: "Make Longer", callback_data: "config_longer" },
    { text: "Create Variation", callback_data: "config_variation" },
    { text: "Add Emojis", callback_data: "config_emojis" },
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
    await handleConfigCallback(chatId, data, fetch, messageId)
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
  }

  const gptResponse = await getGPTResponse(chatId, prompt + originalText, fetch)

  // Edit the original message instead of sending a new one
  await editMessage(chatId, messageId, gptResponse, fetch)

  // Acknowledge the callback query to remove the loading indicator
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

async function handleConfigCallback(chatId, data, fetch, messageId) {
  if (data === "config_finish") {
    const userConfig = await getUserConfig(chatId)
    await saveUserConfig(chatId, userConfig)
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
    let userConfig = await getUserConfig(chatId)
    if (userConfig.includes(option)) {
      userConfig = userConfig.filter(item => item !== option)
    } else {
      userConfig.push(option)
    }
    await saveUserConfig(chatId, userConfig)

    // Update the configuration message
    const configText =
      "Current configuration:\n" +
      userConfig.join(", ") +
      "\n\nSelect more options or finish configuration."
    const options = [
      { text: "Correct Grammar", callback_data: "config_correct" },
      { text: "Make Shorter", callback_data: "config_shorter" },
      { text: "Make Longer", callback_data: "config_longer" },
      { text: "Create Variation", callback_data: "config_variation" },
      { text: "Add Emojis", callback_data: "config_emojis" },
      { text: "Finish Configuration", callback_data: "config_finish" },
    ]
    const inlineKeyboard = options.map(option => [option])

    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: configText,
          reply_markup: {
            inline_keyboard: inlineKeyboard,
          },
        }),
      }
    )
  }
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
      model: "gpt-4o-mini",
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
