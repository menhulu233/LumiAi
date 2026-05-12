const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
        LevelFormat, Header, Footer, PageNumber } = require('docx');
const fs = require('fs');

const tableBorder = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const cellBorders = { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder };

function cell(text, opts = {}) {
  const { bold = false, header = false, width = 4680 } = opts;
  return new TableCell({
    borders: cellBorders,
    width: { size: width, type: WidthType.DXA },
    shading: header ? { fill: "D5E8F0", type: ShadingType.CLEAR } : undefined,
    verticalAlign: "center",
    children: [new Paragraph({
      alignment: header ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text, bold: bold || header, size: 22 })]
    })]
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 180 },
    children: [new TextRun(text)]
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 140 },
    children: [new TextRun(text)]
  });
}

function p(text, opts = {}) {
  const { bold = false, indent = false } = opts;
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    indent: indent ? { left: 360 } : undefined,
    children: [new TextRun({ text, bold, size: 22 })]
  });
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, color: "000000", font: "Arial" },
        paragraph: { spacing: { before: 360, after: 180 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, color: "000000", font: "Arial" },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 } },
    ]
  },
  numbering: {
    config: [
      { reference: "bullet-list",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }
    ]
  },
  sections: [{
    properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    headers: {
      default: new Header({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "LumiAi \u9879\u76ee\u6982\u8ff0", size: 18, color: "888888" })]
      })] })
    },
    footers: {
      default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "\u7b2c ", size: 18 }),
          new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
          new TextRun({ text: " \u9875 / \u5171 ", size: 18 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 }),
          new TextRun({ text: " \u9875", size: 18 })
        ]
      })] })
    },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 400, after: 200 },
        children: [new TextRun({ text: "LumiAi \u9879\u76ee\u6982\u8ff0", bold: true, size: 48, font: "Arial" })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [new TextRun({ text: "\u5168\u573a\u666f\u4e2a\u4eba\u52a9\u7406 Agent", size: 28, color: "666666" })]
      }),

      h1("\u4e00\u3001\u9879\u76ee\u7b80\u4ecb"),
      p("LumiAi \u662f\u7531\u7f51\u6613\u6709\u9053\u5f00\u53d1\u7684\u5168\u573a\u666f\u4e2a\u4eba\u52a9\u7406 Agent\u3002\u5b83 7\u00d724 \u5c0f\u65f6\u5f85\u547d\uff0c\u80fd\u591f\u5e2e\u4f60\u5b8c\u6210\u65e5\u5e38\u529e\u516c\u4e2d\u7684\u5404\u7c7b\u4e8b\u52a1\u2014\u2014\u6570\u636e\u5206\u6790\u3001\u5236\u4f5c PPT\u3001\u751f\u6210\u89c6\u9891\u3001\u64b0\u5199\u6587\u6863\u3001\u641c\u7d22\u4fe1\u606f\u3001\u6536\u53d1\u90ae\u4ef6\u3001\u5b9a\u65f6\u4efb\u52a1\uff0c\u4ee5\u53ca\u66f4\u591a\u3002"),
      p("\u6838\u5fc3\u662f Cowork \u6a21\u5f0f\u2014\u2014AI \u5728\u672c\u5730\u6216\u6c99\u7bb1\u73af\u5883\u4e2d\u6267\u884c\u5de5\u5177\u3001\u64cd\u4f5c\u6587\u4ef6\u3001\u8fd0\u884c\u547d\u4ee4\uff0c\u4e00\u5207\u90fd\u5728\u7528\u6237\u7684\u76d1\u7763\u4e0b\u81ea\u4e3b\u5b8c\u6210\u3002\u6b64\u5916\uff0c\u652f\u6301\u901a\u8fc7\u9489\u9489\u3001\u98de\u4e66\u3001Telegram\u3001Discord \u7b49 IM \u5e73\u53f0\u8fdc\u7a0b\u89e6\u53d1\u3002"),

      h1("\u4e8c\u3001\u6280\u672f\u6808"),
      new Table({
        columnWidths: [2800, 6560],
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        rows: [
          new TableRow({ tableHeader: true, children: [
            cell("\u5c42\u7ea7", { header: true, width: 2800 }),
            cell("\u6280\u672f", { header: true, width: 6560 })
          ]}),
          new TableRow({ children: [cell("\u6846\u67b6", { width: 2800 }), cell("Electron 40", { width: 6560 })] }),
          new TableRow({ children: [cell("\u524d\u7aef", { width: 2800 }), cell("React 18 + TypeScript", { width: 6560 })] }),
          new TableRow({ children: [cell("\u6784\u5efa", { width: 2800 }), cell("Vite 5", { width: 6560 })] }),
          new TableRow({ children: [cell("\u6837\u5f0f", { width: 2800 }), cell("Tailwind CSS 3", { width: 6560 })] }),
          new TableRow({ children: [cell("\u72b6\u6001\u7ba1\u7406", { width: 2800 }), cell("Redux Toolkit", { width: 6560 })] }),
          new TableRow({ children: [cell("AI \u5f15\u64ce", { width: 2800 }), cell("Claude Agent SDK (Anthropic)", { width: 6560 })] }),
          new TableRow({ children: [cell("\u5b58\u50a8", { width: 2800 }), cell("sql.js (SQLite)", { width: 6560 })] }),
          new TableRow({ children: [cell("Markdown", { width: 2800 }), cell("react-markdown + remark-gfm + rehype-katex", { width: 6560 })] }),
          new TableRow({ children: [cell("\u56fe\u8868", { width: 2800 }), cell("Mermaid", { width: 6560 })] }),
          new TableRow({ children: [cell("\u5b89\u5168", { width: 2800 }), cell("DOMPurify", { width: 6560 })] }),
          new TableRow({ children: [cell("IM \u63a5\u5165", { width: 2800 }), cell("dingtalk-stream / Lark SDK / grammY / discord.js", { width: 6560 })] }),
        ]
      }),

      h1("\u4e09\u3001\u6838\u5fc3\u7279\u6027"),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u5168\u573a\u666f\u529e\u516c\u52a9\u7406", size: 22 }), new TextRun({ text: " \u2014 \u6570\u636e\u5206\u6790\u3001PPT \u5236\u4f5c\u3001\u89c6\u9891\u751f\u6210\u3001\u6587\u6863\u64b0\u5199\u3001Web \u641c\u7d22\u3001\u90ae\u4ef6\u6536\u53d1", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u672c\u5730 + \u6c99\u7bb1\u6267\u884c", size: 22 }), new TextRun({ text: " \u2014 \u652f\u6301\u672c\u5730\u76f4\u63a5\u8fd0\u884c\u6216\u9694\u79bb\u7684 Alpine Linux \u6c99\u7bb1", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u5185\u7f6e 16 \u79cd\u6280\u80fd", size: 22 }), new TextRun({ text: " \u2014 Office \u6587\u6863\u3001Web \u641c\u7d22\u3001Playwright \u81ea\u52a8\u5316\u3001Remotion \u89c6\u9891\u7b49", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "Windows \u5185\u7f6e Python \u8fd0\u884c\u65f6", size: 22 }), new TextRun({ text: " \u2014 \u5b89\u88c5\u5305\u5185\u7f6e\u53ef\u76f4\u63a5\u4f7f\u7528\u7684 Python \u89e3\u91ca\u5668", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u5b9a\u65f6\u4efb\u52a1", size: 22 }), new TextRun({ text: " \u2014 \u652f\u6301\u5bf9\u8bdd\u5f0f\u6216 GUI \u754c\u9762\u521b\u5efa\u5b9a\u65f6\u4efb\u52a1", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u6301\u4e45\u8bb0\u5fc6", size: 22 }), new TextRun({ text: " \u2014 \u81ea\u52a8\u63d0\u53d6\u7528\u6237\u504f\u597d\uff0c\u8de8\u4f1a\u8bdd\u8bb0\u4f4f\u4e60\u60ef", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "IM \u8fdc\u7a0b\u64cd\u63a7", size: 22 }), new TextRun({ text: " \u2014 \u901a\u8fc7\u9489\u9489\u3001\u98de\u4e66\u3001Telegram\u3001Discord \u5728\u624b\u673a\u7aef\u89e6\u53d1", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u6743\u9650\u95e8\u63a7", size: 22 }), new TextRun({ text: " \u2014 \u6240\u6709\u654f\u611f\u5de5\u5177\u8c03\u7528\u9700\u7528\u6237\u660e\u786e\u6279\u51c6", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u8de8\u5e73\u53f0", size: 22 }), new TextRun({ text: " \u2014 macOS\uff08Intel + Apple Silicon\uff09\u3001Windows\u3001Linux \u684c\u9762\u7aef", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u6570\u636e\u672c\u5730\u5316", size: 22 }), new TextRun({ text: " \u2014 SQLite \u672c\u5730\u5b58\u50a8\uff0c\u804a\u5929\u8bb0\u5f55\u548c\u914d\u7f6e\u4e0d\u79bb\u5f00\u8bbe\u5907", size: 22 })] }),

      h1("\u56db\u3001\u67b6\u6784\u6982\u89c8"),
      h2("4.1 \u8fdb\u7a0b\u6a21\u578b"),
      p("LumiAi \u91c7\u7528 Electron \u4e25\u683c\u8fdb\u7a0b\u9694\u79bb\u67b6\u6784\uff0c\u6240\u6709\u8de8\u8fdb\u7a0b\u901a\u4fe1\u901a\u8fc7 IPC \u5b8c\u6210\u3002"),
      p("Main Process\uff08src/main/main.ts\uff09\uff1a\u6781\u8584\u5165\u53e3\uff0c\u8f6c\u4ea4 core/app.ts \u2192 lifecycle.ts \u2192 bootstrap.ts\u3002\u8d1f\u8d23\u7a97\u53e3\u751f\u547d\u5468\u671f\u3001SQLite \u6301\u4e45\u5316\u3001CoworkRunner\u3001IM \u7f51\u5173\u3001IPC \u901a\u9053\u6ce8\u518c\u3002", { indent: true }),
      p("Preload Script\uff08src/main/preload.ts\uff09\uff1a\u901a\u8fc7 contextBridge \u66b4\u9732 window.electron API\uff0c\u5305\u542b cowork \u547d\u540d\u7a7a\u95f4\u7528\u4e8e\u4f1a\u8bdd\u7ba1\u7406\u548c\u6d41\u5f0f\u4e8b\u4ef6\u3002", { indent: true }),
      p("Renderer Process\uff08src/renderer/\uff09\uff1aReact 18 + Redux Toolkit + Tailwind CSS\uff0c\u6240\u6709 UI \u548c\u4e1a\u52a1\u903b\u8f91\uff0c\u4ec5\u901a\u8fc7 IPC \u4e0e\u4e3b\u8fdb\u7a0b\u901a\u4fe1\u3002", { indent: true }),

      h2("4.2 \u76ee\u5f55\u7ed3\u6784"),
      new Table({
        columnWidths: [2800, 6560],
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        rows: [
          new TableRow({ tableHeader: true, children: [
            cell("\u76ee\u5f55", { header: true, width: 2800 }),
            cell("\u8bf4\u660e", { header: true, width: 6560 })
          ]}),
          new TableRow({ children: [cell("src/main/", { width: 2800 }), cell("Electron \u4e3b\u8fdb\u7a0b\uff1a\u542f\u52a8\u3001\u751f\u547d\u5468\u671f\u3001\u7a97\u53e3\u3001IPC\u3001\u5404\u9886\u57df\u670d\u52a1", { width: 6560 })] }),
          new TableRow({ children: [cell("src/renderer/", { width: 2800 }), cell("React \u524d\u7aef\uff1aUI \u7ec4\u4ef6\u3001Redux \u72b6\u6001\u3001\u4e1a\u52a1\u670d\u52a1", { width: 6560 })] }),
          new TableRow({ children: [cell("skills/", { width: 2800 }), cell("\u6280\u80fd\u5b9a\u4e49\u76ee\u5f55\uff1a16 \u79cd\u5185\u7f6e\u6280\u80fd", { width: 6560 })] }),
          new TableRow({ children: [cell("build/", { width: 2800 }), cell("\u6784\u5efa\u8d44\u6e90\uff08\u56fe\u6807\u3001\u6743\u9650\u914d\u7f6e\u7b49\uff09", { width: 6560 })] }),
          new TableRow({ children: [cell("docs/", { width: 2800 }), cell("\u6587\u6863\u8d44\u6e90\uff08\u67b6\u6784\u56fe\u7b49\uff09", { width: 6560 })] }),
          new TableRow({ children: [cell("scripts/", { width: 2800 }), cell("\u6784\u5efa\u811a\u672c\u548c\u5de5\u5177", { width: 6560 })] }),
          new TableRow({ children: [cell("tests/", { width: 2800 }), cell("\u6d4b\u8bd5\u6587\u4ef6", { width: 6560 })] }),
        ]
      }),

      h1("\u4e94\u3001Cowork \u7cfb\u7edf"),
      p("Cowork \u662f LumiAi \u7684\u6838\u5fc3\u529f\u80fd\u2014\u2014\u57fa\u4e8e Claude Agent SDK \u7684 AI \u5de5\u4f5c\u4f1a\u8bdd\u7cfb\u7edf\u3002\u5b83\u9762\u5411\u529e\u516c\u573a\u666f\u8bbe\u8ba1\uff0c\u80fd\u591f\u81ea\u4e3b\u5b8c\u6210\u6570\u636e\u5206\u6790\u3001\u6587\u6863\u751f\u6210\u3001\u4fe1\u606f\u68c0\u7d22\u7b49\u590d\u6742\u4efb\u52a1\u3002"),
      h2("5.1 \u6267\u884c\u6a21\u5f0f"),
      new Table({
        columnWidths: [2000, 7360],
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        rows: [
          new TableRow({ tableHeader: true, children: [
            cell("\u6a21\u5f0f", { header: true, width: 2000 }),
            cell("\u8bf4\u660e", { header: true, width: 7360 })
          ]}),
          new TableRow({ children: [cell("auto", { width: 2000 }), cell("\u81ea\u52a8\u6839\u636e\u4e0a\u4e0b\u6587\u9009\u62e9\u6267\u884c\u65b9\u5f0f", { width: 7360 })] }),
          new TableRow({ children: [cell("local", { width: 2000 }), cell("\u672c\u5730\u76f4\u63a5\u6267\u884c\uff0c\u5168\u901f\u8fd0\u884c", { width: 7360 })] }),
          new TableRow({ children: [cell("sandbox", { width: 2000 }), cell("\u9694\u79bb\u7684 Alpine Linux VM\uff0c\u5b89\u5168\u4f18\u5148", { width: 7360 })] }),
        ]
      }),
      h2("5.2 \u6d41\u5f0f\u4e8b\u4ef6"),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "message", size: 22, bold: true }), new TextRun({ text: " \u2014 \u65b0\u6d88\u606f\u52a0\u5165\u4f1a\u8bdd", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "messageUpdate", size: 22, bold: true }), new TextRun({ text: " \u2014 \u6d41\u5f0f\u5185\u5bb9\u589e\u91cf\u66f4\u65b0", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "permissionRequest", size: 22, bold: true }), new TextRun({ text: " \u2014 \u5de5\u5177\u6267\u884c\u9700\u8981\u7528\u6237\u5ba1\u6279", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "complete", size: 22, bold: true }), new TextRun({ text: " \u2014 \u4f1a\u8bdd\u6267\u884c\u5b8c\u6bd5", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "error", size: 22, bold: true }), new TextRun({ text: " \u2014 \u6267\u884c\u51fa\u9519", size: 22 })] }),

      h1("\u516d\u3001\u6280\u80fd\u7cfb\u7edf"),
      p("LumiAi \u5185\u7f6e 16 \u79cd\u6280\u80fd\uff0c\u8986\u76d6\u529e\u516c\u3001\u521b\u4f5c\u3001\u81ea\u52a8\u5316\u7b49\u591a\u79cd\u573a\u666f\uff1a"),
      new Table({
        columnWidths: [2200, 3400, 3760],
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        rows: [
          new TableRow({ tableHeader: true, children: [
            cell("\u6280\u80fd", { header: true, width: 2200 }),
            cell("\u529f\u80fd", { header: true, width: 3400 }),
            cell("\u5178\u578b\u573a\u666f", { header: true, width: 3760 })
          ]}),
          new TableRow({ children: [cell("web-search", { width: 2200 }), cell("Web \u641c\u7d22", { width: 3400 }), cell("\u4fe1\u606f\u68c0\u7d22\u3001\u8d44\u6599\u6536\u96c6", { width: 3760 })] }),
          new TableRow({ children: [cell("docx", { width: 2200 }), cell("Word \u6587\u6863\u751f\u6210", { width: 3400 }), cell("\u62a5\u544a\u64b0\u5199\u3001\u65b9\u6848\u8f93\u51fa", { width: 3760 })] }),
          new TableRow({ children: [cell("xlsx", { width: 2200 }), cell("Excel \u8868\u683c\u751f\u6210", { width: 3400 }), cell("\u6570\u636e\u5206\u6790\u3001\u62a5\u8868\u5236\u4f5c", { width: 3760 })] }),
          new TableRow({ children: [cell("pptx", { width: 2200 }), cell("PowerPoint \u5236\u4f5c", { width: 3400 }), cell("\u6f14\u793a\u6587\u7a3f\u3001\u6c47\u62a5\u6750\u6599", { width: 3760 })] }),
          new TableRow({ children: [cell("pdf", { width: 2200 }), cell("PDF \u5904\u7406", { width: 3400 }), cell("\u6587\u6863\u89e3\u6790\u3001\u683c\u5f0f\u8f6c\u6362", { width: 3760 })] }),
          new TableRow({ children: [cell("remotion", { width: 2200 }), cell("\u89c6\u9891\u751f\u6210", { width: 3400 }), cell("\u5ba3\u4f20\u89c6\u9891\u3001\u6570\u636e\u53ef\u89c6\u5316\u52a8\u753b", { width: 3760 })] }),
          new TableRow({ children: [cell("playwright", { width: 2200 }), cell("Web \u81ea\u52a8\u5316", { width: 3400 }), cell("\u7f51\u9875\u64cd\u4f5c\u3001\u81ea\u52a8\u5316\u6d4b\u8bd5", { width: 3760 })] }),
          new TableRow({ children: [cell("canvas-design", { width: 2200 }), cell("Canvas \u7ed8\u56fe\u8bbe\u8ba1", { width: 3400 }), cell("\u6d77\u62a5\u3001\u56fe\u8868\u8bbe\u8ba1", { width: 3760 })] }),
          new TableRow({ children: [cell("frontend-design", { width: 2200 }), cell("\u524d\u7aef UI \u8bbe\u8ba1", { width: 3400 }), cell("\u539f\u578b\u5236\u4f5c\u3001\u9875\u9762\u8bbe\u8ba1", { width: 3760 })] }),
          new TableRow({ children: [cell("develop-web-game", { width: 2200 }), cell("Web \u6e38\u620f\u5f00\u53d1", { width: 3400 }), cell("\u5c0f\u6e38\u620f\u5feb\u901f\u539f\u578b", { width: 3760 })] }),
          new TableRow({ children: [cell("scheduled-task", { width: 2200 }), cell("\u5b9a\u65f6\u4efb\u52a1", { width: 3400 }), cell("\u5468\u671f\u6027\u5de5\u4f5c\u81ea\u52a8\u6267\u884c", { width: 3760 })] }),
          new TableRow({ children: [cell("weather", { width: 2200 }), cell("\u5929\u6c14\u67e5\u8be2", { width: 3400 }), cell("\u5929\u6c14\u4fe1\u606f\u83b7\u53d6", { width: 3760 })] }),
          new TableRow({ children: [cell("local-tools", { width: 2200 }), cell("\u672c\u5730\u7cfb\u7edf\u5de5\u5177", { width: 3400 }), cell("\u6587\u4ef6\u7ba1\u7406\u3001\u7cfb\u7edf\u64cd\u4f5c", { width: 3760 })] }),
          new TableRow({ children: [cell("create-plan", { width: 2200 }), cell("\u8ba1\u5212\u7f16\u6392", { width: 3400 }), cell("\u9879\u76ee\u89c4\u5212\u3001\u4efb\u52a1\u5206\u89e3", { width: 3760 })] }),
          new TableRow({ children: [cell("skill-creator", { width: 2200 }), cell("\u81ea\u5b9a\u4e49\u6280\u80fd\u521b\u5efa", { width: 3400 }), cell("\u6269\u5c55\u65b0\u80fd\u529b", { width: 3760 })] }),
          new TableRow({ children: [cell("imap-smtp-email", { width: 2200 }), cell("\u90ae\u4ef6\u6536\u53d1", { width: 3400 }), cell("\u90ae\u4ef6\u5904\u7406\u3001\u81ea\u52a8\u56de\u590d", { width: 3760 })] }),
        ]
      }),
      p("\u652f\u6301\u901a\u8fc7 skill-creator \u521b\u5efa\u81ea\u5b9a\u4e49\u6280\u80fd\u5e76\u70ed\u52a0\u8f7d\u3002"),

      h1("\u4e03\u3001IM \u96c6\u6210"),
      p("LumiAi \u652f\u6301\u5c06 Agent \u6865\u63a5\u5230\u591a\u79cd IM \u5e73\u53f0\uff0c\u8ba9\u4f60\u5728\u624b\u673a\u4e0a\u4e5f\u80fd\u8fdc\u7a0b\u89e6\u53d1\u684c\u9762\u7aef Agent\u3002"),
      new Table({
        columnWidths: [2000, 3000, 4360],
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        rows: [
          new TableRow({ tableHeader: true, children: [
            cell("\u5e73\u53f0", { header: true, width: 2000 }),
            cell("\u534f\u8bae", { header: true, width: 3000 }),
            cell("\u8bf4\u660e", { header: true, width: 4360 })
          ]}),
          new TableRow({ children: [cell("\u9489\u9489", { width: 2000 }), cell("DingTalk Stream", { width: 3000 }), cell("\u4f01\u4e1a\u673a\u5668\u4eba\u53cc\u5411\u901a\u4fe1", { width: 4360 })] }),
          new TableRow({ children: [cell("\u98de\u4e66", { width: 2000 }), cell("Lark SDK", { width: 3000 }), cell("\u98de\u4e66\u5e94\u7528\u673a\u5668\u4eba", { width: 4360 })] }),
          new TableRow({ children: [cell("Telegram", { width: 2000 }), cell("grammY", { width: 3000 }), cell("Bot API \u63a5\u5165", { width: 4360 })] }),
          new TableRow({ children: [cell("Discord", { width: 2000 }), cell("discord.js", { width: 3000 }), cell("Discord Bot \u63a5\u5165", { width: 4360 })] }),
          new TableRow({ children: [cell("\u4e91\u4fe1 IM", { width: 2000 }), cell("node-nim V2 SDK", { width: 3000 }), cell("\u7f51\u6613\u4e91\u4fe1 IM P2P \u79c1\u804a", { width: 4360 })] }),
          new TableRow({ children: [cell("\u7f51\u6613\u5c0f\u871c\u8702", { width: 2000 }), cell("node-nim V2 SDK", { width: 3000 }), cell("\u7f51\u6613\u5c0f\u871c\u8702\u4e2a\u4eba\u6570\u5b57\u52a9\u7406", { width: 4360 })] }),
        ]
      }),

      h1("\u516b\u3001\u5b89\u5168\u6a21\u578b"),
      p("LumiAi \u5728\u591a\u4e2a\u5c42\u9762\u5b9e\u65bd\u5b89\u5168\u63a7\u5236\uff1a"),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u8fdb\u7a0b\u9694\u79bb", size: 22, bold: true }), new TextRun({ text: " \u2014 context isolation \u542f\u7528\uff0cnode integration \u7981\u7528", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u6743\u9650\u95e8\u63a7", size: 22, bold: true }), new TextRun({ text: " \u2014 \u654f\u611f\u5de5\u5177\u8c03\u7528\u9700\u7528\u6237\u660e\u786e\u5ba1\u6279", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u6c99\u7bb1\u6267\u884c", size: 22, bold: true }), new TextRun({ text: " \u2014 \u53ef\u9009 Alpine Linux VM \u9694\u79bb\u6267\u884c\u73af\u5883", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u5de5\u4f5c\u533a\u8fb9\u754c", size: 22, bold: true }), new TextRun({ text: " \u2014 \u6587\u4ef6\u64cd\u4f5c\u9650\u5236\u5728\u6307\u5b9a\u5de5\u4f5c\u76ee\u5f55\u5185", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "IPC \u9a8c\u8bc1", size: 22, bold: true }), new TextRun({ text: " \u2014 \u6240\u6709\u8de8\u8fdb\u7a0b\u8c03\u7528\u7ecf\u8fc7\u7c7b\u578b\u68c0\u67e5", size: 22 })] }),

      h1("\u4e5d\u3001\u5f00\u53d1\u89c4\u8303"),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "TypeScript \u4e25\u683c\u6a21\u5f0f\uff0c\u51fd\u6570\u5f0f\u7ec4\u4ef6 + Hooks", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "2 \u7a7a\u683c\u7f29\u8fdb\uff0c\u5355\u5f15\u53f7\uff0c\u5206\u53f7", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u7ec4\u4ef6 PascalCase\uff0c\u51fd\u6570/\u53d8\u91cf camelCase\uff0cRedux \u5207\u7247 *Slice.ts", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "Tailwind CSS \u4f18\u5148\uff0c\u907f\u514d\u81ea\u5b9a\u4e49 CSS", size: 22 })] }),
      new Paragraph({ numbering: { reference: "bullet-list", level: 0 }, children: [new TextRun({ text: "\u63d0\u4ea4\u4fe1\u606f\u9075\u5faa type: short imperative summary \u683c\u5f0f", size: 22 })] }),

      h1("\u5341\u3001\u5feb\u901f\u5f00\u59cb"),
      p("\u73af\u5883\u8981\u6c42\uff1aNode.js >= 24 < 25\uff0cnpm"),
      p("\u5b89\u88c5\u4e0e\u5f00\u53d1\uff1a"),
      new Paragraph({ indent: { left: 720 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "git clone https://github.com/netease-youdao/LumiAi.git", size: 20, font: "Consolas" })] }),
      new Paragraph({ indent: { left: 720 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "cd lumiai", size: 20, font: "Consolas" })] }),
      new Paragraph({ indent: { left: 720 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "npm install", size: 20, font: "Consolas" })] }),
      new Paragraph({ indent: { left: 720 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "npm run electron:dev", size: 20, font: "Consolas" })] }),
      p("\u6253\u5305\u5206\u53d1\uff1a"),
      new Paragraph({ indent: { left: 720 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "npm run dist:mac    # macOS (.dmg)", size: 20, font: "Consolas" })] }),
      new Paragraph({ indent: { left: 720 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "npm run dist:win    # Windows (.exe)", size: 20, font: "Consolas" })] }),
      new Paragraph({ indent: { left: 720 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: "npm run dist:linux  # Linux (.AppImage)", size: 20, font: "Consolas" })] }),

      h1("\u5341\u4e00\u3001\u6570\u636e\u5b58\u50a8"),
      p("\u6240\u6709\u6570\u636e\u5b58\u50a8\u5728\u672c\u5730 SQLite \u6570\u636e\u5e93\uff08lumiai.sqlite\uff0c\u4f4d\u4e8e\u7528\u6237\u6570\u636e\u76ee\u5f55\uff09\u3002"),
      new Table({
        columnWidths: [2800, 6560],
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        rows: [
          new TableRow({ tableHeader: true, children: [
            cell("\u8868", { header: true, width: 2800 }),
            cell("\u7528\u9014", { header: true, width: 6560 })
          ]}),
          new TableRow({ children: [cell("kv", { width: 2800 }), cell("\u5e94\u7528\u914d\u7f6e\u952e\u503c\u5bf9", { width: 6560 })] }),
          new TableRow({ children: [cell("cowork_config", { width: 2800 }), cell("Cowork \u8bbe\u7f6e\uff08\u5de5\u4f5c\u76ee\u5f55\u3001\u7cfb\u7edf\u63d0\u793a\u8bcd\u3001\u6267\u884c\u6a21\u5f0f\uff09", { width: 6560 })] }),
          new TableRow({ children: [cell("cowork_sessions", { width: 2800 }), cell("\u4f1a\u8bdd\u5143\u6570\u636e", { width: 6560 })] }),
          new TableRow({ children: [cell("cowork_messages", { width: 2800 }), cell("\u6d88\u606f\u5386\u53f2", { width: 6560 })] }),
          new TableRow({ children: [cell("scheduled_tasks", { width: 2800 }), cell("\u5b9a\u65f6\u4efb\u52a1\u5b9a\u4e49", { width: 6560 })] }),
        ]
      }),

      h1("\u5341\u4e8c\u3001\u7248\u672c\u4fe1\u606f"),
      new Table({
        columnWidths: [2800, 6560],
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        rows: [
          new TableRow({ tableHeader: true, children: [
            cell("\u9879", { header: true, width: 2800 }),
            cell("\u5185\u5bb9", { header: true, width: 6560 })
          ]}),
          new TableRow({ children: [cell("\u7248\u672c\u53f7", { width: 2800 }), cell("0.2.4", { width: 6560 })] }),
          new TableRow({ children: [cell("\u8bb8\u53ef\u8bc1", { width: 2800 }), cell("MIT License", { width: 6560 })] }),
          new TableRow({ children: [cell("\u5f00\u53d1\u8005", { width: 2800 }), cell("\u7f51\u6613\u6709\u9053 (LumiAi)", { width: 6560 })] }),
          new TableRow({ children: [cell("\u4ed3\u5e93", { width: 2800 }), cell("https://github.com/netease-youdao/LumiAi", { width: 6560 })] }),
        ]
      }),
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("LumiAi项目概述.docx", buffer);
  console.log("Document created: LumiAi项目概述.docx");
});
