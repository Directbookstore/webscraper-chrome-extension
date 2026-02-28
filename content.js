// content.js
console.log("DealMachine Scraper Content Script Loaded.");

let isStopRequested = false;
let isScrapingActive = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "stopScraping") {
    console.log("🛑 Stop command received from popup");
    isStopRequested = true;
    sendResponse({ success: true });
    return true;
  }

  if (request.action !== "executeScraperInContent") {
    return;
  }

  if (isScrapingActive) {
    console.warn("⚠️ Scraper already running");
    sendResponse({ success: false, error: "Scraper is already running" });
    return true;
  }

  const jwt = request.token;
  const siteToken = localStorage.getItem("token");

  if (!jwt || !siteToken) {
    console.error("Missing tokens - JWT:", !!jwt, "Site Token:", !!siteToken);
    sendResponse({ success: false, count: 0, error: "Missing authentication tokens" });
    return true;
  }

  console.log("🚀 Starting scraper with tokens...");
  isStopRequested = false;
  isScrapingActive = true;

  // Function to send progress to popup
  const sendProgress = (page, count) => {
    chrome.runtime.sendMessage({
      action: "scraperProgress",
      page: page,
      count: count
    }).catch(err => console.debug("Popup closed, skipping progress update"));
  };

  // Fetch one page of leads
  async function fetchLeadsPage(page, pageSize = 100) {
    const payload = {
      token: siteToken,
      sort_by: "date_created_desc",
      limit: pageSize,
      begin: (page - 1) * pageSize,
      search: "",
      search_type: "address",
      filters: null,
      old_filters: null,
      list_id: "all_leads",
      list_history_id: null,
      get_updated_data: false,
      property_flags: "",
      property_flags_and_or: "or",
    };

    const res = await fetch("https://api.dealmachine.com/v2/leads/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`DealMachine API error ${res.status}`);
    }

    return res.json();
  }

  // Fetch property details (includes phone_numbers with contact phone_1/2/3)
  async function fetchPropertyDetails(prop) {
    const payload = {
      token: siteToken,
      property_id: prop.property_id || prop.propertyId || prop.property_id_str,
      property_data_id: prop.property_data_id || prop.property_dataId || prop.property_address_mak,
      property_data_type: prop.property_data_type || prop.property_dataType || "datatree",
      property_address_mak: prop.property_address_mak,
    };

    // Remove empty keys so we don't send junk
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
        delete payload[key];
      }
    }

    if (!payload.property_id && !payload.property_data_id && !payload.property_address_mak) {
      return null;
    }

    const res = await fetch("https://api.dealmachine.com/v2/property/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Property API error ${res.status}`);
    }

    const json = await res.json();
    return (json && json.results && json.results.property) || null;
  }

  (async () => {
    try {
      const pageSize = 100;
      let page = 1;
      const seen = new Set();
      const propertyDetailCache = new Map();
      const seenProperties = new Set();
      let totalExpected = null;
      let repeatPageCount = 0;
      let total = 0;

      // CSV header
      const rows = [
        [
          "Street",
          "City",
          "State",
          "Zip",
          "PhoneNumber",
          "FirstName",
          "MiddleName",
          "LastName",
        ],
      ];

      console.log("📊 Starting to fetch leads...");

      while (true) {
        if (isStopRequested) {
          console.log("🛑 Scraping stopped by user");
          break;
        }

        sendProgress(page, total);
        console.log(`⏳ Fetching page ${page}...`);
        const json = await fetchLeadsPage(page, pageSize);
        const props = (json.results && json.results.properties) || [];

        if (totalExpected === null) {
          const possibleTotals = [
            json?.results?.total,
            json?.results?.total_count,
            json?.results?.count,
            json?.results?.total_results,
            json?.results?.properties_total,
            json?.results?.totalProperties,
            json?.total,
            json?.count,
          ].filter((v) => Number.isFinite(v));
          if (possibleTotals.length > 0) {
            totalExpected = Math.max(...possibleTotals);
          }
        }

        console.log(`📄 Page ${page}: got ${props.length} properties${totalExpected ? ` (total ~${totalExpected})` : ""}`);

        if (props.length === 0) {
          console.log("✅ No more properties, stopping pagination");
          break;
        }

        const allowAllPhoneTypes = true;

        const normalizePhone = (value) => {
          if (value === null || value === undefined) return "";
          const raw = String(value).trim();
          if (!raw) return "";
          // Skip values that look encrypted (common in API responses)
          if (/[=:]/.test(raw)) return "";
          const hasPlus = raw.startsWith("+");
          const digits = raw.replace(/\D/g, "");
          if (!digits) return "";
          // Avoid encrypted blobs or short fragments; keep plausible phone lengths.
          if (digits.length < 10 || digits.length > 15) return "";
          return hasPlus ? `+${digits}` : digits;
        };

        const tryAddNumber = (raw, street, city, state, zip, contact) => {
          const normalized = normalizePhone(raw);
          if (!normalized || seen.has(normalized)) return false;
          seen.add(normalized);
          total++;
          rows.push([
            street,
            city,
            state,
            zip,
            String(raw).trim(),
            contact?.given_name || "",
            contact?.surname || "",
          ]);
          return true;
        };

        const extractNumbersFromProperty = (prop, street, city, state, zip) => {
          let added = 0;
          const phoneNumbers = prop.phone_numbers || [];

          for (const ph of phoneNumbers) {
            const type = String(ph.type || ph.phone_type || ph.phoneType || "").toLowerCase();
            const carrier = String(ph.carrier || "").toLowerCase();
            const isWireless =
              ph.is_wireless === true ||
              type === "w" ||
              type === "wireless" ||
              type === "cell" ||
              type === "mobile" ||
              (!type && carrier.includes("wireless"));
            const isLandline =
              ph.landline === 1 ||
              type === "l" ||
              type === "landline";
            const isAllowed = allowAllPhoneTypes || isWireless || isLandline;

            if (!isAllowed) continue;

            const c = ph.contact || {};

            // Prefer the phone number on the phone record itself
            const directCandidates = [
              ph.number,
              ph.phone_number,
              ph.phone,
              ph.raw_number,
              ph.formatted_number,
              ph.formatted,
              ph.e164,
            ];
            for (const num of directCandidates) {
              if (num) {
                if (tryAddNumber(num, street, city, state, zip, c)) added++;
              }
            }

            // Fallback to contact-level phones if direct number isn't present
            const contactCandidates = [
              c.phone_1,
              c.phone_2,
              c.phone_3,
              c.phone,
              c.phone_number,
              c.mobile_phone,
              c.cell_phone,
              c.cell,
            ];
            for (const num of contactCandidates) {
              if (num) {
                if (tryAddNumber(num, street, city, state, zip, c)) added++;
              }
            }
          }

          // Fallback: sometimes numbers are only in contacts, not phone_numbers
          const allContacts = prop.all_contacts || prop.contacts || [];
          for (const c of allContacts) {
            const contactCandidates = [
              c.phone_1,
              c.phone_2,
              c.phone_3,
              c.phone,
              c.phone_number,
              c.mobile_phone,
              c.cell_phone,
              c.cell,
            ];

            for (const num of contactCandidates) {
              if (num) {
                if (allowAllPhoneTypes) {
                  if (tryAddNumber(num, street, city, state, zip, c)) added++;
                  continue;
                }

                const t =
                  String(c.phone_1_type || c.phone_2_type || c.phone_3_type || "").toLowerCase();
                const ok =
                  t === "w" || t === "wireless" || t === "cell" || t === "mobile";
                if (ok) {
                  if (tryAddNumber(num, street, city, state, zip, c)) added++;
                }
              }
            }
          }

          return added;
        };

        let newPropsThisPage = 0;
        for (const p of props) {
          const propKey =
            p.property_id ||
            p.property_data_id ||
            p.property_address_mak ||
            p.property_address_full ||
            `${p.property_address || ""}|${p.property_address_city || ""}|${p.property_address_state || ""}|${p.property_address_zip || ""}`;

          if (propKey && seenProperties.has(propKey)) {
            continue;
          }
          if (propKey) {
            seenProperties.add(propKey);
            newPropsThisPage++;
          }

          const street = p.property_address || "";
          const city = p.property_address_city || "";
          const state = p.property_address_state || "";
          const zip = p.property_address_zip || "";

          const addedFromLeads = extractNumbersFromProperty(p, street, city, state, zip);

          // If no numbers were found, try the property details endpoint
          if (addedFromLeads === 0 && !isStopRequested) {
            try {
              const cacheKey = p.property_id || p.property_data_id || p.property_address_mak || p.property_address_full;
              if (!propertyDetailCache.has(cacheKey)) {
                const details = await fetchPropertyDetails(p);
                propertyDetailCache.set(cacheKey, details || null);
              }
              const details = propertyDetailCache.get(cacheKey);
              if (details) {
                extractNumbersFromProperty(details, street, city, state, zip);
              }
            } catch (err) {
              console.warn("Property details fetch failed:", err);
            }
          }
        }

        sendProgress(page, total);

        if (newPropsThisPage === 0) {
          repeatPageCount++;
          if (repeatPageCount >= 2) {
            console.warn("⚠️ No new properties detected for consecutive pages, stopping to avoid loop");
            break;
          }
        } else {
          repeatPageCount = 0;
        }

        if (totalExpected !== null && seenProperties.size >= totalExpected) {
          console.log("✅ Reached expected total properties");
          break;
        }

        page++;

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      console.log(`🎉 Scraping complete! Total unique wireless numbers: ${total}`);

      if (total === 0) {
        console.warn("⚠️ No wireless numbers found");
        isScrapingActive = false;
        sendResponse({
          success: false,
          count: 0,
          error: "No wireless numbers found in your leads",
          shouldLog: true,
          logData: { dataCount: 0, status: "completed", jwt }
        });
        return;
      }

      // Build CSV text
      const csvText = rows
        .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
        .join("\r\n");

      // Trigger CSV download
      const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
      const link = document.createElement("a");
      const timestamp = new Date().toISOString().slice(0, 10);
      link.href = URL.createObjectURL(blob);
      link.download = `dealmachine_wireless_${timestamp}_${total}${isStopRequested ? '_PARTIAL' : ''}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();

      console.log("💾 CSV file downloaded");

      isScrapingActive = false;
      // Send success response with logging info
      sendResponse({
        success: true,
        count: total,
        stoppedManually: isStopRequested,
        shouldLog: true,
        logData: { dataCount: total, status: isStopRequested ? "stopped" : "completed", jwt }
      });

    } catch (err) {
      console.error("🚨 Scraper Error:", err);
      isScrapingActive = false;
      sendResponse({
        success: false,
        count: 0,
        error: err.message || "Unknown error occurred",
        shouldLog: true,
        logData: { dataCount: 0, status: "failed", jwt }
      });
    }
  })();

  return true; // keep the message channel open for async response
});
