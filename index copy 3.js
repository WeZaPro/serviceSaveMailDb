require("dotenv").config(); // โหลดค่าจาก .env
const fs = require("fs");
const path = require("path");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const axios = require("axios");

const RESULT_PATH = path.join(__dirname, "result.json");
const PROCESSED_PATH = path.join(__dirname, "processed.json");

const SUBJECT_FILTER = process.env.SUBJECT_FILTER || "Happy EV Taxi Phuket";

let processed = [];
if (fs.existsSync(PROCESSED_PATH)) {
  try {
    processed = JSON.parse(fs.readFileSync(PROCESSED_PATH));
  } catch {
    processed = [];
  }
}

// === IMAP CONFIG ===
const imap = new Imap({
  user: "info.happyev@gmail.com", //process.env.EMAIL_USER,
  password: "biic jthj hqah czzy", //process.env.EMAIL_PASS,
  host: "imap.gmail.com",
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
});

function openInbox(cb) {
  imap.openBox("INBOX", false, cb);
}

async function sendResultsToAPI(results) {
  const apiURL =
    process.env.API_IMPORT_EMAIL_RESULTS ||
    "https://api.happyevtravelandtransfer.com/import-email-results";

  console.log("📤 ส่งข้อมูลไป API:", apiURL);
  try {
    const response = await axios.post(apiURL, { data: results });
    console.log("✅ ส่งข้อมูลสำเร็จ:", response.data);
  } catch (error) {
    console.error("❌ ส่งข้อมูลไม่สำเร็จ:", error.message);
  }
}

async function parseEmailToJSON(bodyText) {
  if (!bodyText || bodyText.trim().length === 0) {
    console.log("⚠️ Email body is empty");
    return;
  }

  console.log("🔍 Parsing email body...");
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
      const [part1, ...rest] = rawDestination.split("-");
      form = part1.trim();
      to = rest.join("-").trim();
    }

    const totalMatches = [...block.matchAll(/Total\s+฿([0-9,.]+)/g)];
    const Total =
      totalMatches.length > 0
        ? `฿${totalMatches[totalMatches.length - 1][1]}`
        : "";

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

  const filteredResults = results.filter((obj) =>
    Object.values(obj).some((value) => value !== "")
  );

  if (filteredResults.length === 0) {
    console.log("ℹ️ ไม่มีข้อมูลที่ดึงออกมาได้");
    return;
  }

  let existing = [];
  if (fs.existsSync(RESULT_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(RESULT_PATH, "utf8"));
    } catch {
      console.error("⚠️ อ่าน result.json ไม่สำเร็จ, เริ่มใหม่");
      existing = [];
    }
  }

  const existingOrders = new Set(existing.map((item) => item.Order));
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

  await sendResultsToAPI(uniqueResults);
}

// === IMAP EVENTS ===
imap.once("ready", () => {
  console.log("✅ IMAP Connected");
  openInbox((err, box) => {
    if (err) throw err;
    console.log("📬 เปิดกล่องจดหมายสำเร็จ");

    imap.on("mail", () => {
      console.log("📥 มีเมลเข้าใหม่");
      fetchLatestMail();
    });
  });
});

imap.once("error", (err) => {
  console.error("❌ IMAP Error:", err);
});

imap.once("end", () => {
  console.log("📴 IMAP Disconnected. Reconnecting...");
  setTimeout(() => imap.connect(), 5000);
});

function fetchLatestMail() {
  imap.search(["UNSEEN"], (err, results) => {
    if (err) {
      console.error("🔍 Search error:", err);
      return;
    }

    if (!results || results.length === 0) {
      console.log("📭 ไม่มีเมลใหม่ที่ยังไม่ได้อ่าน");
      return;
    }

    const latest = results.slice(-1);
    const fetch = imap.fetch(latest, {
      bodies: "",
      markSeen: true,
    });

    fetch.on("message", (msg) => {
      let uid;
      msg.on("attributes", (attrs) => {
        uid = attrs.uid;
      });

      msg.on("body", (stream) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) return console.error("❌ Parse error:", err);

          const subject = parsed.subject || "";
          const body = parsed.text || parsed.html || "";

          if (!uid) {
            console.warn("⚠️ ไม่มี UID");
            return;
          }

          if (!subject.toLowerCase().includes(SUBJECT_FILTER.toLowerCase())) {
            console.log(
              `⏭️ ข้ามเมล uid:${uid} หัวข้อไม่ตรงกับ '${SUBJECT_FILTER}'`
            );
            return;
          }

          if (processed.includes(uid)) {
            console.log(`⏭️ ข้ามเมล uid:${uid} (เคยประมวลผลแล้ว)`);
            return;
          }

          console.log("\n🆕 New Email");
          console.log("📌 Subject:", subject);
          console.log("👤 From:", parsed.from?.text || "");
          console.log("📄 Text preview:", body.trim().slice(0, 300));

          try {
            await parseEmailToJSON(body);
            processed.push(uid);
            fs.writeFileSync(
              PROCESSED_PATH,
              JSON.stringify(processed, null, 2)
            );
            console.log(`✅ บันทึก uid ${uid} แล้ว`);
          } catch (e) {
            console.error("❌ Error processing email:", e);
          }
        });
      });
    });

    fetch.once("end", () => {
      console.log("✅ Fetch completed");
    });
  });
}

imap.connect();
