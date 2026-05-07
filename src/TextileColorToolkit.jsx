import { useState, useCallback, useMemo, useEffect } from "react";
import {
    ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from "recharts";

// ─── Color Math ────────────────────────────────────────────────────────────
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

const cmykToRgb = (c, m, y, k) => ({
    r: Math.round(255 * (1 - c / 100) * (1 - k / 100)),
    g: Math.round(255 * (1 - m / 100) * (1 - k / 100)),
    b: Math.round(255 * (1 - y / 100) * (1 - k / 100)),
});

const rgbToCmyk = (r, g, b) => {
    let c = 1 - r / 255;
    let m = 1 - g / 255;
    let y = 1 - b / 255;
    let k = Math.min(c, m, y);
    if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
    return {
        c: Math.max(0, Math.min(100, Math.round(((c - k) / (1 - k)) * 100))),
        m: Math.max(0, Math.min(100, Math.round(((m - k) / (1 - k)) * 100))),
        y: Math.max(0, Math.min(100, Math.round(((y - k) / (1 - k)) * 100))),
        k: Math.max(0, Math.min(100, Math.round(k * 100)))
    };
};

const rgbToHex = ({ r, g, b }) =>
    `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;

const rgbToLab = ({ r, g, b }) => {
    const lin = (v) => { v = Math.max(0, Math.min(255, v)) / 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
    const [R, G, B] = [r, g, b].map(lin);
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return { L: 116 * f(Y) - 16, a: 500 * (f(X) - f(Y)), b: 200 * (f(Y) - f(Z)) };
};

const deltaE = (l1, l2) => Math.sqrt((l1.L - l2.L) ** 2 + (l1.a - l2.a) ** 2 + (l1.b - l2.b) ** 2);
const luma = ({ r, g, b }) => (r * 0.299 + g * 0.587 + b * 0.114) / 255;

// ─── Printer Definitions ───────────────────────────────────────────────────
const DEFAULT_INK_LIMITS = { sublimation: 260, reactive: 320, pigment: 300 };

const PRINTER_BASE = {
    sublimation: {
        label: "Sublimation", short: "SUB", accent: "#FF6B35",
        desc: "Dye-sub · Polyester · High vibrancy · Warm shift",
        profile: "sRGB-Sublimation-ISOcoated_v2",
        gamutNote: "Widest gamut ~120% sRGB. Strong C/M boost.",
        transform: (c, m, y, k) => ({ c: clamp(c * 1.08), m: clamp(m * 1.06), y: clamp(y * 0.97), k: clamp(k * 0.82) }),
    },
    reactive: {
        label: "Reactive", short: "RCT", accent: "#00C9B1",
        desc: "Reactive dye · Cotton/Natural · Deep blacks · Cool shift",
        profile: "ISOcoated_v2-Reactive-AdobeRGB",
        gamutNote: "Excellent depth. Cool tone, superior black density.",
        transform: (c, m, y, k) => ({ c: clamp(c * 1.04), m: clamp(m * 0.96), y: clamp(y * 0.93), k: clamp(k * 1.12) }),
    },
    pigment: {
        label: "Pigment", short: "PIG", accent: "#A8E063",
        desc: "Pigment ink · Multi-substrate · Natural tones · UV-stable",
        profile: "GRACoL2013-Pigment-CoatedV3",
        gamutNote: "Moderate gamut. Muted naturals, excellent lightfastness.",
        transform: (c, m, y, k) => ({ c: clamp(c * 0.94), m: clamp(m * 0.92), y: clamp(y * 0.98), k: clamp(k * 1.05) }),
    },
};

const applyTAC = (adj, limit) => {
    const total = adj.c + adj.m + adj.y + adj.k;
    if (total <= limit) return adj;
    const r = limit / total;
    return { c: adj.c * r, m: adj.m * r, y: adj.y * r, k: adj.k * r };
};

// ─── Reference Profiles ────────────────────────────────────────────────────
const REF_PROFILES = {
    sRGB: { label: "sRGB", maxChroma: 100, desc: "Standard web/screen reference" },
    adobeRGB: { label: "Adobe RGB (1998)", maxChroma: 130, desc: "Wider gamut photography standard" },
    fogra39: { label: "FOGRA39 (Coated)", maxChroma: 90, desc: "European offset coated standard" },
    gracol: { label: "GRACoL 2013", maxChroma: 95, desc: "North American commercial print" },
    swop: { label: "SWOP v2", maxChroma: 85, desc: "US publications standard" },
};

const checkGamutWarning = (lab, refKey) => {
    const ref = REF_PROFILES[refKey];
    const chroma = Math.sqrt(lab.a ** 2 + lab.b ** 2);
    return chroma > ref.maxChroma * (Math.max(0, lab.L) / 100);
};

// ─── Presets ───────────────────────────────────────────────────────────────
const PRESETS = [
    { name: "Rich Black", c: 60, m: 40, y: 40, k: 100 },
    { name: "Cyan", c: 100, m: 0, y: 0, k: 0 },
    { name: "Magenta", c: 0, m: 100, y: 0, k: 0 },
    { name: "Yellow", c: 0, m: 0, y: 100, k: 0 },
    { name: "Red", c: 0, m: 90, y: 80, k: 0 },
    { name: "Cobalt Blue", c: 85, m: 60, y: 0, k: 0 },
    { name: "Forest Green", c: 75, m: 0, y: 100, k: 20 },
    { name: "Coral", c: 0, m: 55, y: 55, k: 0 },
];

// ─── 20 Chip Variations ────────────────────────────────────────────────────
const generate20Chips = (cmyk) => {
    const chips = [];
    [100, 80, 60, 40, 20].forEach((pct, i) => chips.push({
        label: `Tint ${pct}%`, row: 0, col: i,
        c: cmyk.c * pct / 100, m: cmyk.m * pct / 100, y: cmyk.y * pct / 100, k: cmyk.k * pct / 100,
    }));
    [0, 15, 30, 50, 70].forEach((addK, i) => chips.push({
        label: `Shade K+${addK}`, row: 1, col: i,
        c: clamp(cmyk.c * 0.9), m: clamp(cmyk.m * 0.9), y: clamp(cmyk.y * 0.9), k: clamp(cmyk.k + addK),
    }));
    [-20, -10, 0, 10, 20].forEach((shift, i) => chips.push({
        label: shift < 0 ? `Cool ${Math.abs(shift)}` : shift > 0 ? `Warm +${shift}` : "Neutral",
        row: 2, col: i,
        c: clamp(cmyk.c - shift * 0.8), m: clamp(cmyk.m + shift * 0.4), y: clamp(cmyk.y + shift * 0.6), k: cmyk.k,
    }));
    [100, 80, 60, 40, 20].forEach((sat, i) => {
        const avg = (cmyk.c + cmyk.m + cmyk.y) / 3;
        chips.push({
            label: `Sat ${sat}%`, row: 3, col: i,
            c: clamp(cmyk.c * sat / 100 + avg * (1 - sat / 100)),
            m: clamp(cmyk.m * sat / 100 + avg * (1 - sat / 100)),
            y: clamp(cmyk.y * sat / 100 + avg * (1 - sat / 100)),
            k: cmyk.k,
        });
    });
    return chips;
};

// ─── Gamut Sampling ────────────────────────────────────────────────────────
const STEPS = [0, 25, 50, 75, 100];
const buildGamutPoints = () => {
    const result = {};
    Object.entries(PRINTER_BASE).forEach(([key, printer]) => {
        const pts = [];
        STEPS.forEach(c => STEPS.forEach(m => STEPS.forEach(y => {
            const adj = printer.transform(c, m, y, 0);
            const rgb = cmykToRgb(adj.c, adj.m, adj.y, 0);
            const lab = rgbToLab(rgb);
            pts.push({ a: parseFloat(lab.a.toFixed(1)), b: parseFloat(lab.b.toFixed(1)), L: parseFloat(lab.L.toFixed(1)) });
        })));
        result[key] = pts;
    });
    return result;
};
const GAMUT_POINTS = buildGamutPoints();

// ─── Export ────────────────────────────────────────────────────────────────
const exportCSV = (cmyk, outputs, inkLimits) => {
    const rows = [
        ["ChromaShift · Digital Textile Color Profile Export"], [""],
        ["SOURCE", "C", "M", "Y", "K"],
        ["", ...["c", "m", "y", "k"].map(ch => cmyk[ch].toFixed(1))], [""],
        ["Printer", "Profile", "TAC Limit", "C Out", "M Out", "Y Out", "K Out", "Total Ink", "ΔE", "HEX"],
        ...outputs.map(o => {
            const rgb = cmykToRgb(o.adj.c, o.adj.m, o.adj.y, o.adj.k);
            const total = (o.adj.c + o.adj.m + o.adj.y + o.adj.k);
            return [o.label, o.profile, inkLimits[o.key] + "%",
            o.adj.c.toFixed(1), o.adj.m.toFixed(1), o.adj.y.toFixed(1), o.adj.k.toFixed(1),
            total.toFixed(1), o.dE.toFixed(2), rgbToHex(rgb).toUpperCase()];
        }),
    ];
    const csv = rows.map(r => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "chromashift_export.csv"; a.click();
    URL.revokeObjectURL(url);
};

const exportPDF = (cmyk, outputs, inkLimits) => {
    const srcRgb = cmykToRgb(cmyk.c, cmyk.m, cmyk.y, cmyk.k);
    const srcHex = rgbToHex(srcRgb);
    const html = `<!DOCTYPE html><html><head><title>ChromaShift Spec Sheet</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@400;600&display=swap');
  *{box-sizing:border-box} body{font-family:'DM Sans',sans-serif;background:#fff;color:#111;margin:0;padding:36px;max-width:800px}
  h1{font-size:20px;font-weight:600;margin:0 0 2px} .mono{font-family:'Space Mono',monospace}
  .sub{font-size:9px;color:#888;letter-spacing:.18em;margin-bottom:24px}
  .source{display:flex;gap:20px;padding:16px;background:#f5f5f5;border-radius:8px;margin-bottom:24px;align-items:center}
  .swatch{width:72px;height:72px;border-radius:6px;flex-shrink:0}
  .label{font-size:8px;color:#999;letter-spacing:.12em;margin-bottom:2px}
  .val{font-size:13px;color:#111}
  table{width:100%;border-collapse:collapse;margin-bottom:20px}
  th{font-size:8px;color:#999;text-align:left;padding:8px 6px;border-bottom:2px solid #111;letter-spacing:.12em}
  td{font-size:11px;padding:10px 6px;border-bottom:1px solid #eee;vertical-align:middle}
  .chip{width:36px;height:22px;border-radius:3px} .de{display:inline-block;padding:2px 6px;border-radius:4px;font-size:9px}
  footer{font-size:9px;color:#bbb;margin-top:28px;border-top:1px solid #eee;padding-top:12px}
  @media print{body{padding:20px}}
</style></head><body>
<h1>ChromaShift · Textile Color Spec Sheet</h1>
<div class="sub mono">CMYK WORKFLOW · ICC v4 · ${new Date().toLocaleDateString("en-US", { dateStyle: "long" })}</div>
<div class="source">
  <div class="swatch" style="background:${srcHex}"></div>
  <div>
    <div class="label mono">SOURCE COLOR</div>
    <div style="font-size:20px;font-weight:600;margin-bottom:6px;font-family:'Space Mono',monospace">${srcHex.toUpperCase()}</div>
    <div style="display:flex;gap:20px">
      ${["C", "M", "Y", "K"].map((ch, i) => `<div><div class="label mono">${ch}</div><div class="val mono">${[cmyk.c, cmyk.m, cmyk.y, cmyk.k][i].toFixed(1)}%</div></div>`).join("")}
    </div>
  </div>
</div>
<table>
  <thead><tr><th>OUTPUT</th><th>PRINTER</th><th>PROFILE</th><th>TAC</th><th>C</th><th>M</th><th>Y</th><th>K</th><th>TOTAL</th><th>ΔE</th></tr></thead>
  <tbody>${outputs.map(o => {
        const rgb = cmykToRgb(o.adj.c, o.adj.m, o.adj.y, o.adj.k);
        const total = o.adj.c + o.adj.m + o.adj.y + o.adj.k;
        const deColor = o.dE < 2 ? "#22c55e" : o.dE < 5 ? "#eab308" : o.dE < 10 ? "#f97316" : "#ef4444";
        const exceeded = total > inkLimits[o.key];
        return `<tr>
      <td><div class="chip" style="background:${rgbToHex(rgb)}"></div></td>
      <td class="mono" style="color:${o.accent};font-size:10px">${o.label}</td>
      <td style="font-size:8px;color:#888">${o.profile}</td>
      <td class="mono">${inkLimits[o.key]}%</td>
      <td class="mono">${o.adj.c.toFixed(1)}%</td><td class="mono">${o.adj.m.toFixed(1)}%</td>
      <td class="mono">${o.adj.y.toFixed(1)}%</td><td class="mono">${o.adj.k.toFixed(1)}%</td>
      <td class="mono" style="color:${exceeded ? "#ef4444" : "#111"}">${total.toFixed(1)}%</td>
      <td><span class="de mono" style="background:${deColor}22;color:${deColor}">${o.dE.toFixed(1)}</span></td>
    </tr>`;
    }).join("")}</tbody>
</table>
<footer class="mono">Generated by ChromaShift · chromashift.io · ICC v4 Digital Textile Workflow</footer>
</body></html>`;
    const w = window.open("", "_blank");
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 500);
};

// ─── Sub-components ────────────────────────────────────────────────────────
const Slider = ({ label, value, onChange, color, min = 0, max = 100 }) => (
    <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: "#555", letterSpacing: "0.12em" }}>{label}</span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 10, color: "#bbb" }}>{Math.round(value)}{max > 100 ? "" : "%"}</span>
        </div>
        <div style={{ position: "relative", height: 5, borderRadius: 3, background: "#1a1a1e" }}>
            <div style={{ position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 3, width: `${((value - min) / (max - min)) * 100}%`, background: `linear-gradient(to right,${color}55,${color})` }} />
            <input type="range" min={min} max={max} step={1} value={value} onChange={e => onChange(parseFloat(e.target.value))}
                style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "pointer", margin: 0 }} />
            <div style={{ position: "absolute", top: "50%", transform: "translateY(-50%)", left: `calc(${((value - min) / (max - min)) * 100}% - 6px)`, width: 12, height: 12, borderRadius: "50%", background: "#fff", boxShadow: `0 0 0 2px ${color},0 2px 4px #0008`, pointerEvents: "none" }} />
        </div>
    </div>
);

const DeltaBadge = ({ value }) => {
    const [col, bg, txt] = value < 2 ? ["#5dba5d", "#1a3a1a", "Imperceptible"] : value < 5 ? ["#c9b800", "#2a2a0a", "Slight"] : value < 10 ? ["#ff8c42", "#2a1a0a", "Noticeable"] : ["#ff4f4f", "#2a0a0a", "Significant"];
    return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", background: bg, border: `1px solid ${col}22`, borderRadius: 5, padding: "3px 8px" }}>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, fontWeight: 700, color: col }}>ΔE {value.toFixed(1)}</span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: col, opacity: 0.7 }}>{txt}</span>
        </span>
    );
};

const STab = ({ label, active, onClick, accent }) => (
    <button onClick={onClick} style={{ padding: "7px 13px", fontSize: 9, fontFamily: "'Space Mono',monospace", letterSpacing: "0.1em", cursor: "pointer", background: "transparent", border: "none", borderBottom: active ? `2px solid ${accent || "#fff"}` : "2px solid transparent", color: active ? (accent || "#e0e0e0") : "#444", transition: "all 0.15s", whiteSpace: "nowrap" }}>
        {label}
    </button>
);

const ROW_LABELS = ["TINTS", "SHADES", "WARM / COOL", "SATURATION"];

// ─── Main ──────────────────────────────────────────────────────────────────
export default function TextileColorToolkit({ initialRgb }) {
    const [cmyk, setCmyk] = useState({ c: 60, m: 20, y: 0, k: 5 });

    useEffect(() => {
        if (initialRgb && initialRgb.length === 3) {
            setCmyk(rgbToCmyk(initialRgb[0], initialRgb[1], initialRgb[2]));
        }
    }, [initialRgb]);
    const [activeType, setActiveType] = useState("sublimation");
    const [rightTab, setRightTab] = useState("output");
    const [inkLimits, setInkLimits] = useState({ ...DEFAULT_INK_LIMITS });
    const [showInkPanel, setShowInkPanel] = useState(false);
    const [refProfile, setRefProfile] = useState("sRGB");
    const [renderIntent, setRenderIntent] = useState("perceptual");

    const setChannel = useCallback((ch) => (val) => setCmyk(p => ({ ...p, [ch]: val })), []);
    const setLimit = useCallback((key) => (val) => setInkLimits(p => ({ ...p, [key]: val })), []);

    const sourceRgb = useMemo(() => cmykToRgb(cmyk.c, cmyk.m, cmyk.y, cmyk.k), [cmyk]);
    const sourceLab = useMemo(() => rgbToLab(sourceRgb), [sourceRgb]);
    const sourceHex = useMemo(() => rgbToHex(sourceRgb), [sourceRgb]);
    const totalInk = cmyk.c + cmyk.m + cmyk.y + cmyk.k;

    const outputs = useMemo(() =>
        Object.entries(PRINTER_BASE).map(([key, p]) => {
            const raw = p.transform(cmyk.c, cmyk.m, cmyk.y, cmyk.k);
            const adj = applyTAC(raw, inkLimits[key]);
            const rgb = cmykToRgb(adj.c, adj.m, adj.y, adj.k);
            const dE = deltaE(sourceLab, rgbToLab(rgb));
            const total = adj.c + adj.m + adj.y + adj.k;
            return { key, ...p, adj, rgb, dE, total, tacExceeded: total > inkLimits[key] };
        }), [cmyk, inkLimits, sourceLab]);

    const activeOutput = outputs.find(o => o.key === activeType);
    const activePrinter = PRINTER_BASE[activeType];

    const chips = useMemo(() => generate20Chips(cmyk), [cmyk]);

    const softProofWarning = useMemo(() =>
        activeOutput ? checkGamutWarning(rgbToLab(activeOutput.rgb), refProfile) : false
        , [activeOutput, refProfile]);

    return (
        <div style={{ minHeight: "100vh", background: "#0d0d0f", color: "#ccc", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
            <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" />

            {/* Header */}
            <div style={{ borderBottom: "1px solid #1a1a1e", padding: "16px 26px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#FF6B35,#00C9B1,#A8E063)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div style={{ width: 13, height: 13, borderRadius: 3, background: "#0d0d0f" }} />
                    </div>
                    <div>
                        <div style={{ fontWeight: 600, fontSize: 15, color: "#f0f0f0", letterSpacing: "-0.01em" }}>CHROMASHIFT</div>
                        <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#383838", letterSpacing: "0.2em" }}>TEXTILE COLOR PROFILE MANAGER · CMYK · ICC v4</div>
                    </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                    {[["↓ CSV", () => exportCSV(cmyk, outputs, inkLimits)], ["↓ PDF SPEC", () => exportPDF(cmyk, outputs, inkLimits)]].map(([label, fn]) => (
                        <button key={label} onClick={fn} style={{ padding: "6px 13px", background: "#111114", border: "1px solid #252528", borderRadius: 6, color: "#777", fontFamily: "'Space Mono',monospace", fontSize: 9, cursor: "pointer", letterSpacing: "0.08em" }}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "290px 1fr", maxWidth: 1100, margin: "0 auto", padding: "22px 22px 0" }}>

                {/* ── LEFT: CMYK Controls ── */}
                <div style={{ paddingRight: 22 }}>
                    {/* Swatch */}
                    <div style={{ height: 76, borderRadius: 10, background: sourceHex, marginBottom: 14, border: "1px solid #ffffff06", display: "flex", alignItems: "flex-end", padding: "9px 13px", transition: "background 0.2s" }}>
                        <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 12, fontWeight: 700, color: luma(sourceRgb) > 0.45 ? "#000" : "#fff" }}>{sourceHex.toUpperCase()}</span>
                    </div>

                    <div style={{ fontSize: 8, fontFamily: "'Space Mono',monospace", color: "#383838", letterSpacing: "0.18em", marginBottom: 9 }}>SOURCE CMYK</div>
                    <Slider label="CYAN" value={cmyk.c} onChange={setChannel("c")} color="#00bcd4" />
                    <Slider label="MAGENTA" value={cmyk.m} onChange={setChannel("m")} color="#e91e8c" />
                    <Slider label="YELLOW" value={cmyk.y} onChange={setChannel("y")} color="#ffc107" />
                    <Slider label="KEY (BLACK)" value={cmyk.k} onChange={setChannel("k")} color="#aaa" />

                    {/* TAC bar */}
                    <div style={{ marginBottom: 14, padding: "8px 11px", borderRadius: 6, background: totalInk > 300 ? "#2a0a0a" : "#0a1a0a", border: `1px solid ${totalInk > 300 ? "#ff4f4f33" : "#5dba5d33"}` }}>
                        <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 10, color: totalInk > 300 ? "#ff4f4f" : "#5dba5d" }}>
                            {totalInk > 300 ? `⚠ TAC ${Math.round(totalInk)}% > 300` : `✓ TAC ${Math.round(totalInk)}%`}
                        </div>
                    </div>

                    {/* Ink limit panel */}
                    <button onClick={() => setShowInkPanel(v => !v)} style={{ width: "100%", marginBottom: 8, padding: "7px 11px", background: showInkPanel ? "#111114" : "transparent", border: "1px solid #1a1a1e", borderRadius: 6, color: "#555", fontFamily: "'Space Mono',monospace", fontSize: 8, cursor: "pointer", textAlign: "left", letterSpacing: "0.1em" }}>
                        {showInkPanel ? "▾" : "▸"} CUSTOM INK LIMITS / PRINTER
                    </button>
                    {showInkPanel && (
                        <div style={{ background: "#111114", borderRadius: 8, padding: "14px 14px 8px", border: "1px solid #1e1e22", marginBottom: 12 }}>
                            {Object.entries(PRINTER_BASE).map(([key, p]) => (
                                <Slider key={key} label={`${p.short} TAC MAX`} value={inkLimits[key]} onChange={setLimit(key)} color={p.accent} min={150} max={400} />
                            ))}
                            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#383838", marginTop: 4 }}>Excess ink is proportionally clipped per channel</div>
                        </div>
                    )}

                    {/* Presets */}
                    <div style={{ fontSize: 8, fontFamily: "'Space Mono',monospace", color: "#383838", letterSpacing: "0.18em", marginBottom: 8 }}>PRESETS</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
                        {PRESETS.map(p => {
                            const rgb = cmykToRgb(p.c, p.m, p.y, p.k);
                            const isA = cmyk.c === p.c && cmyk.m === p.m && cmyk.y === p.y && cmyk.k === p.k;
                            return (
                                <button key={p.name} onClick={() => setCmyk({ c: p.c, m: p.m, y: p.y, k: p.k })}
                                    style={{ background: rgbToHex(rgb), border: isA ? "2px solid #fff" : "2px solid transparent", borderRadius: 6, padding: "6px 8px", color: luma(rgb) > 0.45 ? "#111" : "#eee", fontFamily: "'Space Mono',monospace", fontSize: 9, cursor: "pointer", textAlign: "left" }}>
                                    {p.name}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* ── RIGHT ── */}
                <div style={{ borderLeft: "1px solid #1a1a1e", paddingLeft: 22 }}>

                    {/* Printer type selector */}
                    <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
                        {Object.entries(PRINTER_BASE).map(([key, p]) => (
                            <button key={key} onClick={() => setActiveType(key)} style={{ flex: 1, padding: "8px 4px", background: activeType === key ? "#111114" : "transparent", border: activeType === key ? `1px solid ${p.accent}33` : "1px solid #1a1a1e", borderBottom: activeType === key ? `2px solid ${p.accent}` : "1px solid #1a1a1e", borderRadius: "7px 7px 0 0", color: activeType === key ? p.accent : "#3a3a3a", fontFamily: "'Space Mono',monospace", fontSize: 10, cursor: "pointer", transition: "all 0.15s" }}>
                                {p.short}
                                <div style={{ fontSize: 8, opacity: 0.6, marginTop: 2 }}>{p.label}</div>
                            </button>
                        ))}
                    </div>

                    {/* Content tabs */}
                    <div style={{ display: "flex", borderBottom: "1px solid #1a1a1e", marginBottom: 18, gap: 2, overflowX: "auto" }}>
                        {[["output", "OUTPUT"], ["gamut", "GAMUT MAP"], ["chips", "20 CHIPS"], ["softproof", "SOFT PROOF"]].map(([id, lbl]) => (
                            <STab key={id} label={lbl} active={rightTab === id} onClick={() => setRightTab(id)} accent={activePrinter.accent} />
                        ))}
                    </div>

                    {/* ══ OUTPUT ══ */}
                    {rightTab === "output" && activeOutput && (
                        <div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#111114", borderRadius: 8, padding: "12px 15px", marginBottom: 14, border: `1px solid ${activePrinter.accent}1a` }}>
                                <div>
                                    <div style={{ color: activePrinter.accent, fontWeight: 600, fontSize: 14 }}>{activePrinter.label}</div>
                                    <div style={{ color: "#484848", fontSize: 11, marginTop: 2 }}>{activePrinter.desc}</div>
                                    <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#2a2a2a", marginTop: 4 }}>{activePrinter.profile}</div>
                                </div>
                                <div style={{ textAlign: "right" }}>
                                    <DeltaBadge value={activeOutput.dE} />
                                    {activeOutput.tacExceeded && <div style={{ marginTop: 5, fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#ff4f4f" }}>⚠ clipped to {inkLimits[activeType]}%</div>}
                                </div>
                            </div>

                            {/* 3-way blocks */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                                {outputs.map(o => {
                                    const hex = rgbToHex(o.rgb); const lu = luma(o.rgb);
                                    return (
                                        <div key={o.key} onClick={() => setActiveType(o.key)}
                                            style={{ background: hex, borderRadius: 9, padding: "14px 12px", cursor: "pointer", outline: activeType === o.key ? `2px solid ${o.accent}` : "2px solid transparent", outlineOffset: 2, transition: "all 0.15s" }}>
                                            <div style={{ color: lu > 0.45 ? "#000" : "#fff" }}>
                                                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, opacity: 0.55, letterSpacing: "0.12em" }}>{o.label}</div>
                                                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, fontWeight: 700, marginBottom: 6 }}>{hex.toUpperCase()}</div>
                                                {["C", "M", "Y", "K"].map((ch, i) => (
                                                    <div key={ch} style={{ display: "flex", justifyContent: "space-between", fontFamily: "'Space Mono',monospace", fontSize: 9, lineHeight: 1.8, opacity: 0.7 }}>
                                                        <span>{ch}</span><span>{Math.round([o.adj.c, o.adj.m, o.adj.y, o.adj.k][i])}%</span>
                                                    </div>
                                                ))}
                                                <div style={{ marginTop: 5, fontFamily: "'Space Mono',monospace", fontSize: 8, opacity: 0.5 }}>ΔE {o.dE.toFixed(1)}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Correction table */}
                            <div style={{ background: "#111114", borderRadius: 9, padding: "14px 16px", border: "1px solid #1e1e22" }}>
                                <div style={{ fontSize: 8, fontFamily: "'Space Mono',monospace", color: "#383838", letterSpacing: "0.15em", marginBottom: 10 }}>CHANNEL CORRECTION · {activePrinter.label.toUpperCase()}</div>
                                <div style={{ display: "grid", gridTemplateColumns: "80px repeat(4,1fr)", gap: 3 }}>
                                    {["", "C", "M", "Y", "K"].map((h, i) => (
                                        <div key={i} style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#383838", textAlign: "center", paddingBottom: 5, borderBottom: "1px solid #1a1a1e" }}>{h}</div>
                                    ))}
                                    {[["SOURCE", "#888", [cmyk.c, cmyk.m, cmyk.y, cmyk.k]], ["OUTPUT", activePrinter.accent, [activeOutput.adj.c, activeOutput.adj.m, activeOutput.adj.y, activeOutput.adj.k]]].map(([rowL, col, vals]) => (
                                        <>{[rowL, ...vals].map((v, i) => (
                                            <div key={i} style={{ fontFamily: "'Space Mono',monospace", fontSize: i === 0 ? 8 : 11, color: col, textAlign: i === 0 ? "left" : "center", padding: "7px 3px", display: i === 0 ? "flex" : undefined, alignItems: i === 0 ? "center" : undefined }}>
                                                {i === 0 ? v : `${Math.round(v)}%`}
                                            </div>
                                        ))}</>
                                    ))}
                                    {["", "c", "m", "y", "k"].map((ch, i) => {
                                        if (i === 0) return <div key="dl" style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#383838", borderTop: "1px solid #1a1a1e", display: "flex", alignItems: "center", padding: "7px 0" }}>DELTA</div>;
                                        const d = Math.round(activeOutput.adj[ch] - cmyk[ch]);
                                        const col = d > 0 ? "#5dba5d" : d < 0 ? "#ff6b6b" : "#444";
                                        return <div key={ch} style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, color: col, textAlign: "center", padding: "7px 3px", borderTop: "1px solid #1a1a1e" }}>{d > 0 ? `+${d}` : d === 0 ? "—" : d}</div>;
                                    })}
                                </div>
                                {/* Cross-printer ΔE */}
                                <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #1a1a1e", display: "flex", gap: 8 }}>
                                    {outputs.map(o => (
                                        <div key={o.key} style={{ flex: 1, textAlign: "center" }}>
                                            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: o.accent, marginBottom: 4 }}>{o.short}</div>
                                            <DeltaBadge value={o.dE} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ══ GAMUT ══ */}
                    {rightTab === "gamut" && (
                        <div>
                            <div style={{ fontSize: 8, fontFamily: "'Space Mono',monospace", color: "#383838", letterSpacing: "0.15em", marginBottom: 12 }}>CIE LAB a*b* GAMUT BOUNDARY · K=0 SAMPLING · 125 pts / PRINTER</div>
                            <div style={{ background: "#111114", borderRadius: 9, padding: "14px", border: "1px solid #1e1e22", marginBottom: 12 }}>
                                <ResponsiveContainer width="100%" height={310}>
                                    <ScatterChart margin={{ top: 8, right: 8, bottom: 16, left: 8 }}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1e" />
                                        <XAxis dataKey="a" type="number" domain={[-100, 100]} tick={{ fontFamily: "'Space Mono',monospace", fontSize: 8, fill: "#383838" }}
                                            label={{ value: "a* (Green ← → Red)", style: { fontFamily: "'Space Mono',monospace", fontSize: 8, fill: "#444" }, position: "insideBottom", offset: -4 }} />
                                        <YAxis dataKey="b" type="number" domain={[-100, 100]} tick={{ fontFamily: "'Space Mono',monospace", fontSize: 8, fill: "#383838" }}
                                            label={{ value: "b*", angle: -90, style: { fontFamily: "'Space Mono',monospace", fontSize: 8, fill: "#444" }, position: "insideLeft", offset: 8 }} />
                                        <ReferenceLine x={0} stroke="#252528" strokeWidth={1} />
                                        <ReferenceLine y={0} stroke="#252528" strokeWidth={1} />
                                        <Tooltip content={({ payload }) => {
                                            if (!payload?.length) return null;
                                            const d = payload[0]?.payload;
                                            return <div style={{ background: "#1a1a1e", border: "1px solid #2a2a2e", borderRadius: 6, padding: "8px 12px", fontFamily: "'Space Mono',monospace", fontSize: 10, color: "#aaa" }}>
                                                <div>L* {d?.L?.toFixed(1)}</div><div>a* {d?.a?.toFixed(1)}</div><div>b* {d?.b?.toFixed(1)}</div>
                                            </div>;
                                        }} />
                                        {Object.entries(GAMUT_POINTS).map(([key, pts]) => (
                                            <Scatter key={key} name={PRINTER_BASE[key].label} data={pts} opacity={0.5}>
                                                {pts.map((_, i) => <Cell key={i} fill={PRINTER_BASE[key].accent} />)}
                                            </Scatter>
                                        ))}
                                        <Scatter name="Current" data={[{ a: sourceLab.a, b: sourceLab.b, L: sourceLab.L }]} opacity={1}>
                                            <Cell fill="#ffffff" />
                                        </Scatter>
                                    </ScatterChart>
                                </ResponsiveContainer>
                            </div>
                            {/* Legend + stats */}
                            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
                                {Object.entries(PRINTER_BASE).map(([key, p]) => (
                                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                        <div style={{ width: 8, height: 8, borderRadius: 2, background: p.accent, opacity: 0.7 }} />
                                        <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#555" }}>{p.label}</span>
                                    </div>
                                ))}
                                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                    <div style={{ width: 8, height: 8, borderRadius: 4, background: "#fff" }} />
                                    <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#555" }}>Current Color</span>
                                </div>
                            </div>
                            <div style={{ background: "#111114", borderRadius: 8, padding: "12px 14px", border: "1px solid #1e1e22", display: "flex", gap: 18, flexWrap: "wrap" }}>
                                {[["L*", sourceLab.L.toFixed(1)], ["a*", sourceLab.a.toFixed(1)], ["b*", sourceLab.b.toFixed(1)], ["C*", Math.sqrt(sourceLab.a ** 2 + sourceLab.b ** 2).toFixed(1)], ["H°", ((Math.atan2(sourceLab.b, sourceLab.a) * 180 / Math.PI + 360) % 360).toFixed(1) + "°"]].map(([l, v]) => (
                                    <div key={l}><div style={{ fontFamily: "'Space Mono',monospace", fontSize: 7, color: "#383838", marginBottom: 2 }}>{l}</div><div style={{ fontFamily: "'Space Mono',monospace", fontSize: 13, color: "#ccc" }}>{v}</div></div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ══ 20 CHIPS ══ */}
                    {rightTab === "chips" && (
                        <div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                <div style={{ fontSize: 8, fontFamily: "'Space Mono',monospace", color: "#383838", letterSpacing: "0.15em" }}>20 VARIATION COLOR CHIPS · {activePrinter.label.toUpperCase()} SIMULATION</div>
                                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 7, color: "#2a2a2a" }}>CLICK TO SET AS SOURCE</div>
                            </div>
                            {[0, 1, 2, 3].map(row => (
                                <div key={row} style={{ marginBottom: 14 }}>
                                    <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 7, color: "#383838", letterSpacing: "0.15em", marginBottom: 5 }}>{ROW_LABELS[row]}</div>
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 5 }}>
                                        {chips.filter(c => c.row === row).map((chip, ci) => {
                                            const adj = applyTAC(activePrinter.transform(chip.c, chip.m, chip.y, chip.k), inkLimits[activeType]);
                                            const rgb = cmykToRgb(adj.c, adj.m, adj.y, adj.k);
                                            const hex = rgbToHex(rgb); const lu = luma(rgb);
                                            const srcRgb = cmykToRgb(chip.c, chip.m, chip.y, chip.k);
                                            const chipDE = deltaE(rgbToLab(srcRgb), rgbToLab(rgb));
                                            return (
                                                <div key={ci} onClick={() => setCmyk({ c: Math.round(chip.c), m: Math.round(chip.m), y: Math.round(chip.y), k: Math.round(chip.k) })}
                                                    style={{ background: hex, borderRadius: 7, padding: "11px 8px", cursor: "pointer", border: "1px solid #ffffff06", transition: "transform 0.1s" }}
                                                    onMouseEnter={e => e.currentTarget.style.transform = "scale(1.04)"}
                                                    onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
                                                    <div style={{ color: lu > 0.45 ? "#000" : "#fff" }}>
                                                        <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 7, opacity: 0.55, marginBottom: 3, lineHeight: 1.3 }}>{chip.label}</div>
                                                        <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, fontWeight: 700, marginBottom: 5 }}>{hex.toUpperCase()}</div>
                                                        {["C", "M", "Y", "K"].map((ch, i) => (
                                                            <div key={ch} style={{ display: "flex", justifyContent: "space-between", fontFamily: "'Space Mono',monospace", fontSize: 7.5, lineHeight: 1.7, opacity: 0.65 }}>
                                                                <span>{ch}</span><span>{Math.round([adj.c, adj.m, adj.y, adj.k][i])}%</span>
                                                            </div>
                                                        ))}
                                                        <div style={{ marginTop: 3, fontFamily: "'Space Mono',monospace", fontSize: 7, opacity: 0.45 }}>ΔE {chipDE.toFixed(1)}</div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ══ SOFT PROOF ══ */}
                    {rightTab === "softproof" && activeOutput && (
                        <div>
                            <div style={{ fontSize: 8, fontFamily: "'Space Mono',monospace", color: "#383838", letterSpacing: "0.15em", marginBottom: 14 }}>SOFT PROOFING · REFERENCE PROFILE SIMULATION</div>

                            <div style={{ marginBottom: 14 }}>
                                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#484848", marginBottom: 7 }}>REFERENCE PROFILE</div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                    {Object.entries(REF_PROFILES).map(([key, p]) => (
                                        <button key={key} onClick={() => setRefProfile(key)} style={{ padding: "5px 11px", fontFamily: "'Space Mono',monospace", fontSize: 8, cursor: "pointer", background: refProfile === key ? activePrinter.accent + "22" : "#111114", border: `1px solid ${refProfile === key ? activePrinter.accent : "#222226"}`, borderRadius: 5, color: refProfile === key ? activePrinter.accent : "#484848" }}>
                                            {p.label}
                                        </button>
                                    ))}
                                </div>
                                <div style={{ marginTop: 5, fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#383838" }}>{REF_PROFILES[refProfile].desc}</div>
                            </div>

                            <div style={{ marginBottom: 16 }}>
                                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#484848", marginBottom: 7 }}>RENDERING INTENT</div>
                                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                                    {[["perceptual", "Perceptual"], ["relative", "Relative Colorimetric"], ["absolute", "Absolute Colorimetric"], ["saturation", "Saturation"]].map(([key, label]) => (
                                        <button key={key} onClick={() => setRenderIntent(key)} style={{ padding: "5px 9px", fontFamily: "'Space Mono',monospace", fontSize: 7.5, cursor: "pointer", background: renderIntent === key ? "#1a1a1e" : "transparent", border: `1px solid ${renderIntent === key ? "#2e2e33" : "#1a1a1e"}`, borderRadius: 5, color: renderIntent === key ? "#888" : "#383838" }}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Side-by-side */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
                                {[
                                    { label: "SOURCE (DISPLAY)", hex: sourceHex, rgb: sourceRgb, lab: sourceLab, accent: "#888" },
                                    { label: `${activePrinter.short} → ${REF_PROFILES[refProfile].label}`, hex: rgbToHex(activeOutput.rgb), rgb: activeOutput.rgb, lab: rgbToLab(activeOutput.rgb), accent: activePrinter.accent },
                                ].map((panel, i) => (
                                    <div key={i}>
                                        <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: panel.accent, marginBottom: 6 }}>{panel.label}</div>
                                        <div style={{ height: 100, borderRadius: 9, background: panel.hex, border: `1px solid ${i === 1 && softProofWarning ? "#ff4f4f44" : "#ffffff06"}` }} />
                                        <div style={{ marginTop: 6, fontFamily: "'Space Mono',monospace", fontSize: 10, color: "#777" }}>{panel.hex.toUpperCase()}</div>
                                        <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#3a3a3a" }}>
                                            L*{panel.lab.L.toFixed(1)} a*{panel.lab.a.toFixed(1)} b*{panel.lab.b.toFixed(1)}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Gamut warning */}
                            <div style={{ padding: "10px 14px", borderRadius: 7, background: softProofWarning ? "#2a0a0a" : "#0a1a0a", border: `1px solid ${softProofWarning ? "#ff4f4f33" : "#5dba5d33"}`, marginBottom: 14 }}>
                                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 11, fontWeight: 700, color: softProofWarning ? "#ff4f4f" : "#5dba5d", marginBottom: 3 }}>
                                    {softProofWarning ? "⚠ OUT OF GAMUT" : "✓ WITHIN GAMUT"}
                                </div>
                                <div style={{ fontSize: 12, color: "#555", lineHeight: 1.5 }}>
                                    {softProofWarning
                                        ? `Exceeds ${REF_PROFILES[refProfile].label} gamut. ${renderIntent === "perceptual" ? "Perceptual intent compresses entire gamut to fit." : renderIntent === "relative" ? "Relative Colorimetric clips out-of-gamut values to boundary." : renderIntent === "absolute" ? "Absolute Colorimetric preserves absolute white point differences." : "Saturation intent maximizes chroma at the cost of hue accuracy."}`
                                        : `Color is fully reproducible within ${REF_PROFILES[refProfile].label}. No clipping expected.`}
                                </div>
                            </div>

                            {/* All printers gamut check */}
                            <div style={{ background: "#111114", borderRadius: 8, padding: "12px 14px", border: "1px solid #1e1e22" }}>
                                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#383838", letterSpacing: "0.13em", marginBottom: 10 }}>ALL PRINTERS vs {REF_PROFILES[refProfile].label.toUpperCase()}</div>
                                {outputs.map(o => {
                                    const oLab = rgbToLab(o.rgb);
                                    const oOOG = checkGamutWarning(oLab, refProfile);
                                    return (
                                        <div key={o.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #171719" }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                                <div style={{ width: 18, height: 18, borderRadius: 3, background: rgbToHex(o.rgb) }} />
                                                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: o.accent }}>{o.short} {o.label}</span>
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                                <DeltaBadge value={o.dE} />
                                                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: oOOG ? "#ff4f4f" : "#5dba5d", minWidth: 60, textAlign: "right" }}>{oOOG ? "OOG" : "IN GAMUT"}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                </div>
            </div>

            {/* Footer */}
            <div style={{ maxWidth: 1100, margin: "18px auto 0", padding: "0 22px" }}>
                <div style={{ borderTop: "1px solid #1a1a1e", paddingTop: 10, display: "flex", gap: 18, flexWrap: "wrap" }}>
                    {[["RGB", `${sourceRgb.r}, ${sourceRgb.g}, ${sourceRgb.b}`], ["HEX", sourceHex.toUpperCase()], ["CMYK", `${Math.round(cmyk.c)} / ${Math.round(cmyk.m)} / ${Math.round(cmyk.y)} / ${Math.round(cmyk.k)}`], ["LAB", `${sourceLab.L.toFixed(0)} · ${sourceLab.a.toFixed(0)} · ${sourceLab.b.toFixed(0)}`], ["CHROMA", Math.sqrt(sourceLab.a ** 2 + sourceLab.b ** 2).toFixed(1)], ["HUE", ((Math.atan2(sourceLab.b, sourceLab.a) * 180 / Math.PI + 360) % 360).toFixed(0) + "°"], ["TAC", `${Math.round(totalInk)}%`]].map(([l, v]) => (
                        <div key={l}><div style={{ fontFamily: "'Space Mono',monospace", fontSize: 7, color: "#2a2a2a", letterSpacing: "0.15em" }}>{l}</div><div style={{ fontFamily: "'Space Mono',monospace", fontSize: 10, color: "#555" }}>{v}</div></div>
                    ))}
                </div>
            </div>
        </div>
    );
}