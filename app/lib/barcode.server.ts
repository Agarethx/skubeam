import { toBuffer } from "@bwip-js/node";

export type BarcodeType = "CODE128" | "QR" | "EAN13" | "EAN8";

const BCID: Record<BarcodeType, string> = {
  CODE128: "code128",
  QR:      "qrcode",
  EAN13:   "ean13",
  EAN8:    "ean8",
};

/**
 * Generates a barcode PNG and returns it as a base64 data URL.
 * Throws if the code is invalid for the selected type.
 */
export async function generateBarcode(
  code: string,
  type: BarcodeType,
): Promise<string> {
  const png = await toBuffer({
    bcid:        BCID[type],
    text:        code,
    scale:       3,
    height:      type === "QR" ? 30 : 12,
    ...(type === "QR" ? { width: 30 } : {}),
    includetext: type !== "QR",
    textxalign:  "center",
  });

  return `data:image/png;base64,${png.toString("base64")}`;
}
