import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getForecastForShop } from "../models/forecast.server";

// pdfkit is marked as ssr.external in vite.config.ts — imported as CJS default
import PDFDocument from "pdfkit";

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;

  const { rows } = await getForecastForShop(shopId);

  // Only include SKUs that need replenishment
  const itemsToOrder = rows
    .filter((r) => r.status === "critical" || r.status === "low")
    .map((r) => ({
      ...r,
      suggested_qty: Math.max(1, r.reorder_point - r.total_stock),
    }))
    .sort((a, b) => {
      // critical first, then low
      if (a.status === "critical" && b.status !== "critical") return -1;
      if (b.status === "critical" && a.status !== "critical") return 1;
      return (a.sku_code ?? "").localeCompare(b.sku_code ?? "");
    });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ── Build PDF ──────────────────────────────────────────────────────────────

  const chunks: Buffer[] = [];

  const doc = new PDFDocument({
    margin: 40,
    size: "A4",
    info: {
      Title: `Orden de Compra - ${shopId}`,
      Author: "SkuBeam",
    },
  });

  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const pdfDone = new Promise<void>((resolve) => doc.on("end", resolve));

  // ── Header ────────────────────────────────────────────────────────────────

  doc
    .fontSize(20)
    .font("Helvetica-Bold")
    .text("Orden de Compra", { align: "center" });

  doc.moveDown(0.4);

  doc
    .fontSize(11)
    .font("Helvetica")
    .text(`Tienda: ${shopId}`, { align: "center" });

  doc.text(`Fecha: ${today}`, { align: "center" });

  doc.moveDown(1.2);

  // ── Table header ──────────────────────────────────────────────────────────

  const COL = {
    sku:      { x: 40,  w: 100 },
    title:    { x: 145, w: 180 },
    stock:    { x: 330, w: 70  },
    reorder:  { x: 405, w: 80  },
    qty:      { x: 490, w: 70  },
  };

  const ROW_H = 18;
  const HEADER_Y = doc.y;

  doc.rect(40, HEADER_Y, 520, ROW_H).fill("#1A1A1A");

  doc.fillColor("white").fontSize(9).font("Helvetica-Bold");

  const headerLabels: [keyof typeof COL, string][] = [
    ["sku",     "SKU"],
    ["title",   "Producto"],
    ["stock",   "Stock actual"],
    ["reorder", "Punto reorden"],
    ["qty",     "Cantidad sug."],
  ];

  for (const [key, label] of headerLabels) {
    doc.text(label, COL[key].x + 4, HEADER_Y + 4, {
      width: COL[key].w - 8,
      align: key === "stock" || key === "reorder" || key === "qty" ? "right" : "left",
      lineBreak: false,
    });
  }

  doc.moveDown(0);
  let rowY = HEADER_Y + ROW_H;

  // ── Table rows ────────────────────────────────────────────────────────────

  doc.fontSize(9).font("Helvetica");

  for (let i = 0; i < itemsToOrder.length; i++) {
    const item = itemsToOrder[i];
    const bg = i % 2 === 0 ? "#F6F6F6" : "#FFFFFF";

    doc.rect(40, rowY, 520, ROW_H).fill(bg);

    // Status indicator dot
    const dotColor = item.status === "critical" ? "#D82C0D" : "#E3911C";
    doc.circle(48, rowY + ROW_H / 2, 3).fill(dotColor);

    doc.fillColor("#1A1A1A");

    const cellText: [keyof typeof COL, string | number][] = [
      ["sku",     item.sku_code ?? ""],
      ["title",   item.title ?? "—"],
      ["stock",   item.total_stock],
      ["reorder", item.reorder_point],
      ["qty",     item.suggested_qty],
    ];

    for (const [key, value] of cellText) {
      doc.text(String(value), COL[key].x + 4, rowY + 4, {
        width: COL[key].w - 8,
        align: key === "stock" || key === "reorder" || key === "qty" ? "right" : "left",
        lineBreak: false,
        ellipsis: true,
      });
    }

    rowY += ROW_H;

    // Add a new page if we're running out of space
    if (rowY > doc.page.height - 80 && i < itemsToOrder.length - 1) {
      doc.addPage();
      rowY = 40;
    }
  }

  // ── Footer: total units ───────────────────────────────────────────────────

  const totalUnits = itemsToOrder.reduce((sum, r) => sum + r.suggested_qty, 0);

  doc.moveDown(1.5);
  doc.moveTo(40, doc.y).lineTo(560, doc.y).stroke("#CCCCCC");
  doc.moveDown(0.5);

  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .fillColor("#1A1A1A")
    .text(`Total de unidades a reponer: ${totalUnits}`, { align: "right" });

  doc.moveDown(0.5);
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#666666")
    .text(
      `Generado el ${today} por SkuBeam · ${itemsToOrder.length} SKU${itemsToOrder.length !== 1 ? "s" : ""} con stock crítico o bajo`,
      { align: "right" },
    );

  doc.end();
  await pdfDone;

  const pdfBuffer = Buffer.concat(chunks);

  return new Response(pdfBuffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename=purchase-order-${today}.pdf`,
    },
  });
};
