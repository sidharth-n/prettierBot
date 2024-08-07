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

        if (message && message.text) {
          // Handle text
          const userText = message.text
          console.log(`Received message: ${userText} (${chatId})`)

          await sendOptionsKeyboard(chatId, userText, fetch)
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

async function sendOptionsKeyboard(chatId, text, fetch) {
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        reply_markup: {
          inline_keyboard: [
            [{ text: "Correct Grammar", callback_data: "correct" }],
            [{ text: "Make Shorter", callback_data: "shorter" }],
            [{ text: "Make Longer", callback_data: "longer" }],
            [{ text: "Create Variation", callback_data: "variation" }],
            [{ text: "Add Emojis", callback_data: "emojis" }],
          ],
        },
      }),
    }
  )
}

async function handleCallbackQuery(chatId, callbackQuery, fetch) {
  const data = callbackQuery.data
  const originalText = callbackQuery.message.text.split("\n")[0]

  let prompt = ""
  switch (data) {
    case "correct":
      prompt =
        "Just correct the grammar and spelling of the following and return. Make no other changes: "
      break
    case "shorter":
      prompt = "Make the following text shorter without changing its meaning: "
      break
    case "longer":
      prompt =
        "Make the following text longer without changing its main meaning: "
      break
    case "variation":
      prompt = "Create a variation of the following text with similar length: "
      break
    case "emojis":
      prompt = "Add appropriate emojis to the following text: "
      break
  }

  const gptResponse = await getGPTResponse(prompt + originalText, fetch)
  await sendMessage(chatId, gptResponse, fetch)
}

async function getGPTResponse(prompt, fetch) {
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
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    }),
  })

  const data = await response.json()
  return data.choices[0].message.content
}

async function sendMessage(chatId, text, fetch) {
  await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    }
  )
}
