// Builds XLSX workbooks that look like the ones spreadsheet applications
// actually emit, for tests that must exercise the real parser.
//
// WHY THIS EXISTS. A hand-rolled two-part archive proved nothing: the parser
// passed against it and still returned "That workbook has no rows in it." for a
// real five-sheet workbook. The difference was everything a real writer adds —
// [Content_Types].xml, _rels/.rels, styles, a `<workbookPr/>` element before
// `<sheets>`, XML declarations, self-closing tags with no space, and a shared
// string table. So this builder emits all of it.

const zlib = require("node:zlib");

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Assembles a real ZIP archive with a proper central directory. */
function zip(files, { comment = "" } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, "utf8");
    const stored = file.stored === true;
    const payload = stored ? content : zlib.deflateRawSync(content);
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(Buffer.concat([local, nameBuffer, payload]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuffer]));

    offset += 30 + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const commentBuffer = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuffer.length, 20);
  return Buffer.concat([...locals, centralBuffer, eocd, commentBuffer]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** One worksheet's XML, using the shared string table like Excel does. */
function sheetXml(rows, sharedStrings) {
  const indexOf = (value) => {
    const existing = sharedStrings.indexOf(value);
    if (existing >= 0) return existing;
    sharedStrings.push(value);
    return sharedStrings.length - 1;
  };
  const column = (index) => {
    let name = "";
    let n = index;
    do {
      name = String.fromCharCode(65 + (n % 26)) + name;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return name;
  };

  const body = rows
    .map((cells, rowIndex) => {
      const r = rowIndex + 1;
      const rendered = cells
        .map((value, columnIndex) => {
          const ref = `${column(columnIndex)}${r}`;
          if (value === null || value === undefined || value === "") return "";
          if (typeof value === "number") {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="s"><v>${indexOf(String(value))}</v></c>`;
        })
        .join("");
      return `<row r="${r}" spans="1:${cells.length}">${rendered}</row>`;
    })
    .join("");

  return (
    XML +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    `<sheetFormatPr defaultRowHeight="15"/><sheetData>${body}</sheetData>` +
    "<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>" +
    "</worksheet>"
  );
}

/**
 * Builds a workbook.
 *
 * @param sheets [{ name, rows }] in tab order. `rows` may be empty.
 * @param options.sheetPartOrder  when set, the part filenames are assigned in a
 *   DIFFERENT order from the tab order — which real writers do after a sheet is
 *   reordered or deleted, and which is why part names cannot be trusted.
 */
function buildWorkbook(sheets, options = {}) {
  const sharedStrings = [];
  const sheetParts = sheets.map((sheet, index) => {
    const partIndex = options.sheetPartOrder
      ? options.sheetPartOrder[index]
      : index + 1;
    return {
      ...sheet,
      partName: `xl/worksheets/sheet${partIndex}.xml`,
      relId: `rId${index + 1}`,
      xml: sheetXml(sheet.rows ?? [], sharedStrings),
    };
  });

  const workbookXml =
    XML +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/>' +
    "<workbookPr/>" +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12210"/></bookViews>' +
    "<sheets>" +
    sheetParts
      .map(
        (sheet, index) =>
          `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="${sheet.relId}"/>`
      )
      .join("") +
    "</sheets>" +
    '<calcPr calcId="0"/>' +
    "</workbook>";

  // Relationship ids are deliberately NOT in numeric order relative to the
  // sheets, and the styles/sharedStrings relationships are interleaved — both
  // of which real writers do.
  const workbookRels =
    XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetParts
      .map(
        (sheet) =>
          `<Relationship Id="${sheet.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheet.partName.replace(
            "xl/",
            ""
          )}"/>`
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    "</Relationships>";

  const sharedStringsXml =
    XML +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
    sharedStrings
      .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
      .join("") +
    "</sst>";

  const contentTypes =
    XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheetParts
      .map(
        (sheet) =>
          `<Override PartName="/${sheet.partName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    "</Types>";

  const rootRels =
    XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  const styles =
    XML +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs>' +
    "</styleSheet>";

  // Real writers put [Content_Types].xml first and STORE it uncompressed.
  const files = [
    { name: "[Content_Types].xml", content: contentTypes, stored: true },
    { name: "_rels/.rels", content: rootRels },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRels },
    ...sheetParts.map((sheet) => ({ name: sheet.partName, content: sheet.xml })),
    { name: "xl/styles.xml", content: styles },
    { name: "xl/sharedStrings.xml", content: sharedStringsXml },
  ];

  return zip(files, options.zipOptions);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The exact workbook shape from the staging smoke test: five sheets, the first
 * of which is a populated Inventory sheet, plus an instructions-only README.
 */
function buildSmokeTestWorkbook(options = {}) {
  return buildWorkbook(
    [
      {
        name: "Inventory",
        rows: [
          ["Item SKU", "Available", "Warehouse", "Unit Cost", "Currency"],
          ["SKU-A", 13, "LONDON", 4.5, "USD"],
          ["SKU-B", 8, "LONDON", 2, "USD"],
          ["SKU-D", 4, "LONDON", 7.25, "USD"],
        ],
      },
      {
        name: "3PL Rate Card",
        rows: [
          ["Charge Type", "Agreed Rate", "Charged Per", "Currency"],
          ["Pick Fee", 2, "item", "USD"],
          ["Pack Fee", 1.25, "order", "USD"],
        ],
      },
      {
        name: "3PL Invoice",
        rows: [
          ["Order Number", "Service", "Quantity", "Amount", "Currency"],
          ["1001", "Pick Fee", 4, 10, "USD"],
          ["1002", "Pack Fee", 1, 1.25, "USD"],
        ],
      },
      {
        name: "Supplier Shipment",
        rows: [
          ["SKU", "Ordered Qty", "Received Qty", "Tracking Number"],
          ["SKU-A", 100, 92, "TRK-0001"],
          ["SKU-B", 50, 50, "TRK-0002"],
        ],
      },
      {
        name: "README",
        rows: [
          ["How to use this workbook"],
          ["Each sheet is a separate upload."],
        ],
      },
    ],
    options
  );
}

module.exports = { buildWorkbook, buildSmokeTestWorkbook, zip, sheetXml };
