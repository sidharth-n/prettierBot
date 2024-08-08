const { createClient } = require("@libsql/client")

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const conversationHistory = {}
const customCommandStates = {}

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
          } else if (customCommandStates[chatId]) {
            await handleCustomCommandInput(chatId, userText, fetch)
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
          id: "correct",
          title: "Correct Grammar and spelling",
          prompt:
            "Just correct the grammar and spelling of the following and return: ",
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
            id: "correct",
            title: "Correct Grammar and spelling",
            prompt:
              "Just correct the grammar and spelling of the following and return: ",
          },
        ]
  } catch (error) {
    console.error(`Error getting user config: ${error.message}`)
    return [
      {
        id: "correct",
        title: "Correct Grammar and spelling",
        prompt:
          "Just correct the grammar and spelling of the following and return: ",
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
    "Set your preferred commands.\n\n" + "You can select multiple options."

  const defaultOptions = [
    { id: "correct", title: "Correct Grammar and spelling" },
    { id: "concise", title: "Make concise and Clear" },
    { id: "shorter", title: "Make Shorter" },
    { id: "longer", title: "Make Longer" },
    { id: "variation", title: "Create Variation" },
    { id: "emojis", title: "Add Emojis" },
  ]

  const userConfig = await getUserConfig(chatId)

  const inlineKeyboard = defaultOptions
    .concat(
      userConfig.filter(cmd => !defaultOptions.some(opt => opt.id === cmd.id))
    )
    .map(option => {
      const isSelected = userConfig.some(item => item.id === option.id)
      return [
        {
          text: `${isSelected ? "✅ " : ""}${option.title}`,
          callback_data: `config_${option.id}`,
        },
      ]
    })

  inlineKeyboard.push([
    { text: "Add Custom Command", callback_data: "add_custom_command" },
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

  if (data === "add_custom_command") {
    await handleAddCustomCommand(chatId, messageId, fetch)
    return
  }

  if (data.startsWith("config_")) {
    await handleConfigOption(
      chatId,
      data.replace("config_", ""),
      messageId,
      fetch
    )
    return
  }

  if (data === "save_preferences") {
    const userConfig = await getUserConfig(chatId)
    const configText = userConfig.map(item => item.title).join(", ")
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text: `Congratulations! Your preferences have been saved: ${configText}.\n\nYou can now start sending me text to process. \n\n
          Note : Use /config anytime to edit your preferences.`,
        }),
      }
    )
    return
  }

  const originalText = callbackQuery.message.text
  const userConfig = await getUserConfig(chatId)
  const selectedCommand = userConfig.find(item => item.id === data)

  if (selectedCommand) {
    const gptResponse = await getGPTResponse(
      chatId,
      selectedCommand.prompt + originalText,
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
  const index = userConfig.findIndex(item => item.id === option)
  if (index !== -1) {
    userConfig.splice(index, 1)
  } else {
    const defaultOptions = {
      correct: {
        id: "correct",
        title: "Correct Grammar and spelling",
        prompt:
          "Just correct the grammar and spelling of the following and return: ",
      },
      concise: {
        id: "concise",
        title: "Make concise and Clear",
        prompt: "Make the following text concise and clear: ",
      },
      shorter: {
        id: "shorter",
        title: "Make Shorter",
        prompt:
          "Make the following text shorter by 20% without changing its main meaning: ",
      },
      longer: {
        id: "longer",
        title: "Make Longer",
        prompt:
          "Make the following text longer by 20% without changing its main meaning: ",
      },
      variation: {
        id: "variation",
        title: "Create Variation",
        prompt:
          "Create a variation of the following text with similar length: ",
      },
      emojis: {
        id: "emojis",
        title: "Add Emojis",
        prompt: "Add appropriate emojis to the following text: ",
      },
    }
    if (defaultOptions[option]) {
      userConfig.push(defaultOptions[option])
    } else {
      const customOption = userConfig.find(item => item.id === option)
      if (customOption) {
        userConfig.push(customOption)
      }
    }
  }
  await saveUserConfig(chatId, userConfig)
  await startConfiguration(chatId, fetch)
}

async function sendOptionsKeyboard(chatId, text, fetch, userConfig) {
  const options = userConfig.map(option => {
    return [{ text: option.title, callback_data: option.id }]
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
  const options = userConfig.map(option => {
    return [{ text: option.title, callback_data: option.id }]
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
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that processes and formats text commands.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    }),
  })

  const data = await response.json()
  return data.choices[0].message.content
}

async function handleAddCustomCommand(chatId, messageId, fetch) {
  customCommandStates[chatId] = true
  const promptText =
    "Cool! Now you can add your own custom preferences. Just type in the command you want to add. For example: 'Make the text formatted for WhatsApp'. Make sure to start with 'Make the text...'"

  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: promptText,
      }),
    }
  )
}

async function handleCustomCommandInput(chatId, userInput, fetch) {
  if (!userInput.toLowerCase().startsWith("make the text")) {
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Please enter a valid text formatting command starting with 'Make the text...'. Press /config to restart.",
        }),
      }
    )
    customCommandStates[chatId] = false
    return
  }

  const gptPrompt = `
    Format the following user-provided custom command for a text processing bot:
    "${userInput}"
    
    Return a JSON object with the following structure:
    {
      "id": "a-kebab-case-id",
      "title": "The formatted title of the command",
      "prompt": "The prompt to be sent to GPT for text processing"
    }

    Ensure the 'id' is in kebab-case, derived from the title, and no longer than 20 characters.
    The 'title' should be a cleaned up, properly capitalized version of the user's input.
    The 'prompt' should be formatted to work well with GPT for text processing.
  `

  try {
    const gptResponse = await getGPTResponse(chatId, gptPrompt, fetch)
    const newCommand = JSON.parse(gptResponse)

    if (!newCommand.id || !newCommand.title || !newCommand.prompt) {
      throw new Error("Invalid command structure")
    }

    let userConfig = await getUserConfig(chatId)
    userConfig.push(newCommand)
    await saveUserConfig(chatId, userConfig)

    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Your custom preference "${newCommand.title}" has been added. Use /config to select it.`,
        }),
      }
    )

    customCommandStates[chatId] = false
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
          text: "Sorry, I couldn't process your custom command. Please try again or use /config to restart.",
        }),
      }
    )
    customCommandStates[chatId] = false
  }
}
