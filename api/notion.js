const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { token, databaseId, title, entities, insights, videoUrl } = req.body || {};

  if (!token || !databaseId) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing token or databaseId" });
  }

  const videoTitle = title || "Untitled Video";

  // Build rich text body organized by section
  const TYPE_ORDER = { person: "People", people: "People", event: "Events", concept: "Concepts", organization: "Organizations", stock: "Stocks", commodity: "Commodities", ingredient: "Ingredients" };
  const grouped = {};
  (entities || []).forEach(e => {
    const t = (e.type || "other").toLowerCase();
    const label = TYPE_ORDER[t] || (t.charAt(0).toUpperCase() + t.slice(1));
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(e);
  });

  const bodyChildren = [];

  // Video URL heading
  if (videoUrl) {
    bodyChildren.push({
      object: "block",
      type: "bookmark",
      bookmark: { url: videoUrl }
    });
  }

  // Entity sections
  const sectionOrder = ["People", "Events", "Concepts", "Organizations", "Stocks", "Commodities", "Ingredients"];
  const sortedKeys = Object.keys(grouped).sort((a, b) => {
    const ia = sectionOrder.indexOf(a), ib = sectionOrder.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  for (const label of sortedKeys) {
    bodyChildren.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: label } }] }
    });
    for (const ent of grouped[label]) {
      const text = ent.term + (ent.description ? " — " + ent.description : "");
      bodyChildren.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }]
        }
      });
    }
  }

  // Insights section
  if (insights && insights.length > 0) {
    bodyChildren.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Insights & Tips" } }] }
    });
    for (const ins of insights) {
      const text = (ins.term || ins.insight || "") + (ins.description || ins.detail ? " — " + (ins.description || ins.detail) : "");
      bodyChildren.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }]
        }
      });
    }
  }

  // Build multi-select values from entity terms
  const multiSelect = (entities || []).slice(0, 100).map(e => ({ name: (e.term || "").slice(0, 100) })).filter(e => e.name);

  const notionBody = {
    parent: { database_id: databaseId },
    properties: {
      title: {
        title: [{ text: { content: videoTitle.slice(0, 200) } }]
      },
      ...(videoUrl ? { Video: { url: videoUrl } } : {}),
      ...(multiSelect.length > 0 ? { Entities: { multi_select: multiSelect } } : {})
    },
    children: bodyChildren.slice(0, 100) // Notion API limit
  };

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify(notionBody)
    });

    if (!response.ok) {
      const errBody = await response.text();
      Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(response.status).json({ error: errBody });
    }

    const page = await response.json();
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).json({ success: true, url: page.url });
  } catch (err) {
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: err.message });
  }
};
