require("dotenv").config();
const express = require("express");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const RESULT_PATH = path.join(__dirname, "result.json");
const PROCESSED_PATH = path.join(__dirname, "processed.json");
const SUBJECT_FILTER = "Happy EV Taxi Phuket";

async function parseAndSend(bodyText, uid) {
  if (!bodyText || bodyText.trim().length === 0) {
    console.log("⚠️ Email body is empty");
    return;
  }

  const blocks = bodyText
    .split("บริษัทแฮพเพนอินเมย์ จำกัด")
    .map((b) => b.split("ADVANCE BOOKING")[0]?.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    console.log("⚠️ ไม่พบข้อมูลตาม pattern");
    return;
  }

  const extract = (text, regex) => {
    const match = text.match(regex);
    return match ? match[1].trim() : "";
  };

  const results = blocks.map((block) => {
    const Order = extract(block, /Order:\s*(.+)/);
    const Employee = extract(block, /Employee:\s*(.+)/);
    const POS = extract(block, /POS:\s*(.+)/);
    const LPR = extract(
      block,
      /แคชเชียร์\s*([\u0E00-\u0E7Fa-zA-Z0-9\s]+?)\s*฿0\.00/
    );
    const rawDestination = extract(block, /1 × ฿0\.00\s+(.+)/);

    let form = "",
      to = "";
    if (rawDestination.includes("-")) {
      const [fromPart, ...toPart] = rawDestination.split("-");
      form = fromPart.trim();
      to = toPart.join("-").trim();
    }

    const totalMatches = [...block.matchAll(/Total\s+฿([0-9,.]+)/g)];
    const Total = totalMatches.length > 0 ? `฿${totalMatches.at(-1)[1]}` : "";

    return {
      Order,
      Employee,
      POS,
      LPR,
      destination: rawDestination,
      form,
      to,
      Total,
    };
  });

  const filteredResults = results.filter((r) =>
    Object.values(r).some((val) => val !== "")
  );

  if (filteredResults.length === 0) {
    console.log("ℹ️ ไม่มีข้อมูลที่ดึงออกมาได้จากบล็อก");
    return;
  }

  let existing = [];
  if (fs.existsSync(RESULT_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(RESULT_PATH, "utf8"));
    } catch {
      existing = [];
    }
  }

  const existingOrders = new Set(existing.map((r) => r.Order));
  const uniqueResults = filteredResults.filter(
    (item) => item.Order && !existingOrders.has(item.Order)
  );

  if (uniqueResults.length === 0) {
    console.log("ℹ️ ไม่มี Order ใหม่ (ซ้ำหมด)");
    return;
  }

  const merged = [...existing, ...uniqueResults];
  fs.writeFileSync(RESULT_PATH, JSON.stringify(merged, null, 2), "utf8");
  console.log(`✅ บันทึกเพิ่ม ${uniqueResults.length} รายการ`);

  try {
    const apiURL = process.env.BASE_URL;
    const response = await axios.post(apiURL, { data: uniqueResults });
    console.log("✅ ส่งข้อมูลไป API สำเร็จ:", response.data);
  } catch (error) {
    console.error(
      "❌ ส่ง API ไม่สำเร็จ:",
      error.response?.data || error.message
    );
  }
}

// === MAIN FETCH FUNCTION ===
async function fetchAndProcessEmails() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.EMAIL_USER,
      password: process.env.EMAIL_PASS,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    let processed = [];
    if (fs.existsSync(PROCESSED_PATH)) {
      try {
        processed = JSON.parse(fs.readFileSync(PROCESSED_PATH));
      } catch {
        processed = [];
      }
    }

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err, box) => {
        if (err) return reject(err);

        imap.search(["ALL"], (err, results) => {
          if (err || !results || results.length === 0) {
            console.log("📭 No new mail.");
            imap.end();
            return resolve("No new mail");
          }

          const latest = results.slice(-5);
          const fetch = imap.fetch(latest, { bodies: "", markSeen: true });

          fetch.on("message", (msg) => {
            let uid;
            msg.on("attributes", (attrs) => {
              uid = attrs.uid;
            });

            msg.on("body", (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (!parsed || !parsed.subject) return;

                const subject = parsed.subject.toLowerCase();
                if (!subject.includes(SUBJECT_FILTER.toLowerCase())) return;
                if (processed.includes(uid)) return;

                console.log(`📩 ดึงอีเมลใหม่ uid: ${uid}`);
                await parseAndSend(parsed.text || "", uid);
                processed.push(uid);
              });
            });
          });

          fetch.once("end", () => {
            fs.writeFileSync(
              PROCESSED_PATH,
              JSON.stringify(processed, null, 2)
            );
            imap.end();
            resolve("Processed new mail");
          });
        });
      });
    });

    imap.once("error", (err) => {
      console.error("❌ IMAP error:", err);
      reject(err);
    });

    imap.connect();
  });
}

// === ROUTE ===
app.get("/run-fetch-email", async (req, res) => {
  try {
    const result = await fetchAndProcessEmails();
    res.send(`✅ Done: ${result}`);
  } catch (e) {
    console.error("❌ Error:", e.message);
    res.status(500).send("❌ Error fetching email");
  }
});

app.get("/test", (req, res) => {
  res.send("✅ Hello from Node.js");
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
