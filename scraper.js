// api‑scraper.js
(async () => {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Grab the stored JWT from chrome.storage
  function getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get("jwtToken", ({ jwtToken }) => resolve(jwtToken));
    });
  }

  // Fetch one page of leads from the v2 API
  async function fetchLeadsPage(page, pageSize, token) {
    const res = await fetch("https://api.dealmachine.com/v2/leads/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        page,
        pageSize,
        // …you can mirror any other filters the UI sends here…
      }),
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    // API returns { data: [...], meta: { totalPages, totalCount, page, pageSize } }
    return await res.json();
  }

  // Turn each lead + phone into CSV rows (only Wireless)
  function processLeads(leads) {
    const rows = [];
    for (const lead of leads) {
      const { street, city, state, zip } = lead.address; // adjust if the JSON is shaped differently
      const [first, ...rest] = lead.ownerName.split(" ");
      const last = rest.pop() || "";
      const middle = rest.join(" ");

      for (const p of lead.phoneNumbers) {
        if (p.type.toLowerCase() === "wireless") {
          rows.push([street, city, state, zip, p.number, first, middle, last]);
        }
      }
    }
    return rows;
  }

  // Main
  try {
    const token = await getToken();
    if (!token) throw new Error("No JWT token found—please log in first.");

    const pageSize = 200; // crank this up if your account/API allows
    let page = 1,
      totalPages = 1;
    const allRows = [];

    // CSV header
    const header = [
      "Street",
      "City",
      "State",
      "Zip",
      "Phone",
      "First",
      "Middle",
      "Last",
    ];
    allRows.push(header);

    while (page <= totalPages) {
      console.log(`⏳ Fetching API page ${page}/${totalPages}…`);
      const { data, meta } = await fetchLeadsPage(page, pageSize, token);
      totalPages = meta.totalPages;
      const rows = processLeads(data);
      console.log(`   ↳ ${rows.length} wireless numbers on this page.`);
      allRows.push(...rows);

      page++;
      await delay(100); // small throttle so you don’t hammer their servers
    }

    // Build CSV text
    const csvText = allRows
      .map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(","))
      .join("\n");

    // Download
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `dealmachine_wireless_${allRows.length - 1}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    console.log(`🎉 Done! Exported ${allRows.length - 1} wireless numbers.`);
    window.dispatchEvent(
      new CustomEvent("scraperComplete", {
        detail: { success: true, dataCount: allRows.length - 1 },
      })
    );
  } catch (err) {
    console.error("❌ API Scraper error:", err);
    window.dispatchEvent(
      new CustomEvent("scraperComplete", {
        detail: { success: false, error: err.message, dataCount: 0 },
      })
    );
  }
})();
