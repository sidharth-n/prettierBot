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

        if (!conversationHistory[chatId]) {
          conversationHistory[chatId] = []
        }

        if (message && message.text) {
          const userText = message.text
          console.log(`Received message: ${userText} (${chatId})`)

          await ensureUser(chatId, message.from)

          if (userText === "/start") {
            await sendIntroduction(chatId, fetch)
          } else if (userText === "/config") {
            await startConfiguration(chatId, fetch)
          } else if (
            conversationHistory[chatId].length > 0 &&
            conversationHistory[chatId][conversationHistory[chatId].length - 1]
              .role === "system" &&
            conversationHistory[chatId][conversationHistory[chatId].length - 1]
              .content === "Waiting for custom command"
          ) {
            await processCustomCommand(chatId, userText, fetch)
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

    // Set default config for new users
    const { rows } = await client.execute({
      sql: "SELECT config FROM user_configs WHERE chat_id = ?",
      args: [chatId],
    })
    if (rows.length === 0) {
      await saveUserConfig(chatId, [
        {
          name: "correct",
          prompt: "Correct grammar and spelling for the following text: ",
        },
      ])
    }
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
      : [
          {
            name: "correct",
            prompt: "Correct grammar and spelling for the following text: ",
          },
        ]
  } catch (error) {
    console.error(`Error getting user config: ${error.message}`)
    return [
      {
        name: "correct",
        prompt: "Correct grammar and spelling for the following text: ",
      },
    ]
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
    "Use /config to set up or edit your preferences."

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
    "You can select multiple options. If you select only one option, it will be used as the default command."

  const options = [
    "Correct Grammar and spelling",
    "Make concise and Clear",
    "Make Shorter",
    "Make Longer",
    "Create Variation",
    "Add Emojis",
  ]

  const userConfig = await getUserConfig(chatId)

  const inlineKeyboard = options.map((option, index) => {
    const callbackData = `config_${
      ["correct", "concise", "shorter", "longer", "variation", "emojis"][index]
    }`
    const isSelected = userConfig.some(
      config => config.name === callbackData.replace("config_", "")
    )
    return [
      {
        text: `${isSelected ? "✅ " : ""}${option}`,
        callback_data: callbackData,
      },
    ]
  })

  inlineKeyboard.push([
    { text: "Add Custom Command", callback_data: "custom_command" },
  ])
  inlineKeyboard.push([
    { text: "🔵 SAVE PREFERENCES 🔵", callback_data: "save_preferences" },
  ])

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

async function handleCallbackQuery(chatId, callbackQuery, fetch) {
  const data = callbackQuery.data
  const messageId = callbackQuery.message.message_id

  if (data.startsWith("config_")) {
    await handleConfigOption(
      chatId,
      data.replace("config_", ""),
      messageId,
      fetch
    )
    return
  }

  if (data === "custom_command") {
    await requestCustomCommand(chatId, fetch)
    return
  }

  if (data === "save_preferences") {
    const userConfig = await getUserConfig(chatId)
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `Congratulations! Your preferences have been saved: ${userConfig
            .map(config => config.name)
            .join(
              ", "
            )}.\n\nYou can now start sending me text to process. Use /config anytime to edit your preferences.`,
        }),
      }
    )
    return
  }

  const originalText = callbackQuery.message.text
  const userConfig = await getUserConfig(chatId)
  const selectedConfig = userConfig.find(config => config.name === data)

  if (selectedConfig) {
    const gptResponse = await getGPTResponse(
      chatId,
      selectedConfig.prompt + originalText,
      fetch
    )
    await editMessage(chatId, messageId, gptResponse, fetch)
  }

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

async function handleConfigOption(chatId, option, messageId, fetch) {
  let userConfig = await getUserConfig(chatId)
  const index = userConfig.findIndex(config => config.name === option)
  if (index !== -1) {
    userConfig.splice(index, 1)
  } else {
    const prompt = getDefaultPrompt(option)
    userConfig.push({ name: option, prompt })
  }
  await saveUserConfig(chatId, userConfig)

  await updateConfigMessage(chatId, messageId, fetch)
}

function getDefaultPrompt(option) {
  switch (option) {
    case "correct":
      return "Correct grammar and spelling for the following text: "
    case "concise":
      return "Make the following text concise and clear: "
    case "shorter":
      return "Make the following text shorter by 20% without changing its main meaning: "
    case "longer":
      return "Make the following text longer by 20% without changing its main meaning: "
    case "variation":
      return "Create a variation of the following text with similar length: "
    case "emojis":
      return "Add appropriate emojis to the following text: "
    default:
      return "Process the following text: "
  }
}

async function updateConfigMessage(chatId, messageId, fetch) {
  const configText =
    "Configure your commands. Select the options you'd like to use:\n\n" +
    "You can select multiple options. If you select only one option, it will be used as the default command."

  const options = [
    "Correct Grammar and spelling",
    "Make concise and Clear",
    "Make Shorter",
    "Make Longer",
    "Create Variation",
    "Add Emojis",
  ]

  const userConfig = await getUserConfig(chatId)

  const inlineKeyboard = options.map((optionText, index) => {
    const callbackData = `config_${
      ["correct", "concise", "shorter", "longer", "variation", "emojis"][index]
    }`
    const isSelected = userConfig.some(
      config => config.name === callbackData.replace("config_", "")
    )
    return [
      {
        text: `${isSelected ? "✅ " : ""}${optionText}`,
        callback_data: callbackData,
      },
    ]
  })

  inlineKeyboard.push([
    { text: "Add Custom Command", callback_data: "custom_command" },
  ])
  inlineKeyboard.push([
    { text: "🔵 SAVE PREFERENCES 🔵", callback_data: "save_preferences" },
  ])

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

async function requestCustomCommand(chatId, fetch) {
  conversationHistory[chatId].push({
    role: "system",
    content: "Waiting for custom command",
  })

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Please enter your custom command. For example: 'make the text concise and very clear and beautiful'",
      }),
    }
  )
}

async function processCustomCommand(chatId, customCommand, fetch) {
  const gptPrompt = `Create a JSON object for a custom text processing command. The user's input is: "${customCommand}".
  The JSON should have two fields:
  1. "name": A one-word name for the command (lowercase, no spaces).
  2. "prompt": The full command to be sent to GPT, formatted similarly to: "Correct grammar and spelling for the following text: "
  
  Please ensure the "prompt" field ends with a colon and a space, ready for the user's text to be appended.`

  try {
    const gptResponse = await getGPTResponse(chatId, gptPrompt, fetch)
    let customConfig = JSON.parse(gptResponse)

    let userConfig = await getUserConfig(chatId)
    userConfig.push(customConfig)
    await saveUserConfig(chatId, userConfig)

    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Your custom command "${customConfig.name}" has been added to your preferences.`,
        }),
      }
    )

    conversationHistory[chatId].pop() // Remove the "Waiting for custom command" message
    await startConfiguration(chatId, fetch)
  } catch (error) {
    console.error("Error processing custom command:", error)
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Sorry, I couldn't process your custom command. Please try again or use the predefined options.",
        }),
      }
    )
  }
}

async function sendOptionsKeyboard(chatId, text, fetch, userConfig) {
  const options = userConfig.map(config => {
    return [
      {
        text: config.name.charAt(0).toUpperCase() + config.name.slice(1),
        callback_data: config.name,
      },
    ]
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

async function editMessage(chatId, messageId, text, fetch) {
  const userConfig = await getUserConfig(chatId)
  const options = userConfig.map(config => {
    return [
      {
        text: config.name.charAt(0).toUpperCase() + config.name.slice(1),
        callback_data: config.name,
      },
    ]
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
  try {
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
              "You are a helpful assistant that processes text based on given instructions.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
      }),
    })

    const data = await response.json()
    if (!data.choices || data.choices.length === 0) {
      throw new Error("No response from GPT")
    }
    return data.choices[0].message.content
  } catch (error) {
    console.error("Error getting GPT response:", error)
    return "Sorry, I encountered an error while processing your request. Please try again."
  }
}

// Error handling middleware
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
  // Application specific logging, throwing an error, or other logic here
})

// Helper function to handle API errors
async function handleApiError(chatId, fetch, errorMessage) {
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: errorMessage || "An error occurred. Please try again later.",
      }),
    }
  )
}

// Export the main function
module.exports = async (req, res) => {
  try {
    // ... (the rest of the main function remains unchanged)
  } catch (error) {
    console.error("Unhandled error:", error)
    res.status(500).send("Internal Server Error")
  }
}
