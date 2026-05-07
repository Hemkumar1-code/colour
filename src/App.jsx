import React, { useState, useRef, useEffect } from 'react';
import './index.css';
import TextileColorToolkit from './TextileColorToolkit';
import UTIF from 'utif';

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return `${(h * 360).toFixed(0)}°, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%`;
}

function rgbToCmyk(r, g, b) {
  let c = 1 - (r / 255);
  let m = 1 - (g / 255);
  let y = 1 - (b / 255);
  let k = Math.min(c, Math.min(m, y));
  if (k === 1) return `0%, 0%, 0%, 100%`;
  c = Math.round((c - k) / (1 - k) * 100);
  m = Math.round((m - k) / (1 - k) * 100);
  y = Math.round((y - k) / (1 - k) * 100);
  k = Math.round(k * 100);
  return `${c}%, ${m}%, ${y}%, ${k}%`;
}

function rgbToHex(r, g, b) {
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

function hexToRgbArr(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)] : [0, 0, 0];
}

function rgbToCmykObj(r, g, b) {
  let c = 1 - r / 255; let m = 1 - g / 255; let y = 1 - b / 255;
  let k = Math.min(c, m, y);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: (c - k) / (1 - k) * 100, m: (m - k) / (1 - k) * 100, y: (y - k) / (1 - k) * 100, k: k * 100 };
}
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const cmykToRgbObj = (c, m, y, k) => ({
    r: Math.round(255 * (1 - c / 100) * (1 - k / 100)),
    g: Math.round(255 * (1 - m / 100) * (1 - k / 100)),
    b: Math.round(255 * (1 - y / 100) * (1 - k / 100)),
});
const applyTAC = (adj, limit) => {
    const total = adj.c + adj.m + adj.y + adj.k;
    if (total <= limit) return adj;
    const r = limit / total;
    return { c: adj.c * r, m: adj.m * r, y: adj.y * r, k: adj.k * r };
};
const getPrinterHex = (r, g, b, type) => {
    if (r === undefined || g === undefined || b === undefined) return '';
    const cmyk = rgbToCmykObj(r, g, b);
    let adj;
    if (type === 'rct') {
        adj = { c: clamp(cmyk.c * 1.04), m: clamp(cmyk.m * 0.96), y: clamp(cmyk.y * 0.93), k: clamp(cmyk.k * 1.12) };
        adj = applyTAC(adj, 320);
    } else if (type === 'pig') {
        adj = { c: clamp(cmyk.c * 0.94), m: clamp(cmyk.m * 0.92), y: clamp(cmyk.y * 0.98), k: clamp(cmyk.k * 1.05) };
        adj = applyTAC(adj, 300);
    }
    const rgb = cmykToRgbObj(adj.c, adj.m, adj.y, adj.k);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
};

export default function App() {
  const [mainTab, setMainTab] = useState('studio');
  const [file, setFile] = useState(null);
  const [hasImage, setHasImage] = useState(false);
  const [previewSrc, setPreviewSrc] = useState('');
  const [loading, setLoading] = useState(false);
  
  const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:8001' : '';

  const [palette, setPalette] = useState([]);
  const [selectedColor, setSelectedColor] = useState(null); 
  const [colorDetails, setColorDetails] = useState(null); 
  const [copiedHex, setCopiedHex] = useState(null);
  const [scale, setScale] = useState(1);
  
  const [highlightMode, setHighlightMode] = useState(false);
  const [viewMode, setViewMode] = useState('original'); // 'original', 'reactive', 'pigment'
  const [matrixTab, setMatrixTab] = useState('original'); // 'original', 'rct', 'pig'
  const [hoverColor, setHoverColor] = useState(null);

  const fileInputRef = useRef(null);
  const imageRef = useRef(null);
  const highlightCanvasRef = useRef(null);
  const offscreenCanvasRef = useRef(document.createElement('canvas'));

  // Auto trigger analysis when image loads
  useEffect(() => {
    if (file) {
      analyzeImage();
    }
  }, [file]);

  // Re-apply process (highlight + simulation) if state changes
  useEffect(() => {
    if (hasImage) {
      if (highlightMode || viewMode !== 'original') {
        processImage();
      } else {
        clearHighlight();
      }
    }
  }, [highlightMode, viewMode, selectedColor, hasImage]);

  const loadFile = (f) => {
    if (!f) return;
    const isTif = f.name.toLowerCase().endsWith('.tif') || f.name.toLowerCase().endsWith('.tiff');
    if (!isTif && !f.type.startsWith('image/')) return;
    
    const resetState = (src) => {
      setPreviewSrc(src);
      setFile(f);
      setHasImage(true);
      setPalette([]);
      setSelectedColor(null);
      setColorDetails(null);
      setHighlightMode(false);
      clearHighlight();
    };

    if (isTif) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const buffer = e.target.result;
          const ifds = UTIF.decode(buffer);
          UTIF.decodeImage(buffer, ifds[0]);
          const rgba = UTIF.toRGBA8(ifds[0]);
          const canvas = document.createElement('canvas');
          canvas.width = ifds[0].width;
          canvas.height = ifds[0].height;
          const ctx = canvas.getContext('2d');
          const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer), ifds[0].width, ifds[0].height);
          ctx.putImageData(imgData, 0, 0);
          resetState(canvas.toDataURL('image/png'));
        } catch (err) {
          console.error("TIF decode error", err);
          alert("Failed to read TIF file. It might be corrupted or unsupported.");
        }
      };
      reader.readAsArrayBuffer(f);
    } else {
      const reader = new FileReader();
      reader.onload = (e) => resetState(e.target.result);
      reader.readAsDataURL(f);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadFile(e.dataTransfer.files[0]);
    }
  };

  const onImageLoad = () => {
    const img = imageRef.current;
    if (!img) return;
    const canvas = offscreenCanvasRef.current;
    
    // Scale down huge images to prevent OOM
    const MAX_DIM = 2500;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > MAX_DIM || h > MAX_DIM) {
      const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
      w = Math.floor(w * ratio);
      h = Math.floor(h * ratio);
    }
    
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
  };

  const analyzeImage = async () => {
    setLoading(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('fabricType', 'Twill'); // Maintain backend compat
    try {
      const res = await fetch(`${API_BASE}/api/analyze`, { method: 'POST', body: fd });
      const data = await res.json();
      setPalette(data.extracted_palette || []);
      if (data.extracted_palette && data.extracted_palette.length > 0) {
        handleColorSelect(data.extracted_palette[0]);
      }
    } catch (e) {
      console.error("Backend error:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleColorSelect = async (colorObj) => {
    setSelectedColor(colorObj);
    const fd = new FormData();
    fd.append('r', colorObj.rgb[0]);
    fd.append('g', colorObj.rgb[1]);
    fd.append('b', colorObj.rgb[2]);
    fd.append('fabricType', 'Twill');
    try {
      const res = await fetch(`${API_BASE}/api/process-color`, { method: 'POST', body: fd });
      const data = await res.json();
      setColorDetails(data);
    } catch (e) {}
  };

  const copyToClipboard = (hex) => {
    navigator.clipboard.writeText(hex);
    setCopiedHex(hex);
    setTimeout(() => setCopiedHex(null), 2000);
  };

  const handleMouseMove = (e) => {
    if (!hasImage || !imageRef.current) return;
    const img = imageRef.current;
    const rect = img.getBoundingClientRect();
    
    const elementRatio = rect.width / rect.height;
    const imageRatio = img.naturalWidth / img.naturalHeight;
    
    let renderWidth, renderHeight, xOffset, yOffset;
    if (elementRatio > imageRatio) {
      renderHeight = rect.height;
      renderWidth = renderHeight * imageRatio;
      xOffset = (rect.width - renderWidth) / 2;
      yOffset = 0;
    } else {
      renderWidth = rect.width;
      renderHeight = renderWidth / imageRatio;
      xOffset = 0;
      yOffset = (rect.height - renderHeight) / 2;
    }
    
    const clickX = e.clientX - rect.left - xOffset;
    const clickY = e.clientY - rect.top - yOffset;
    
    if (clickX < 0 || clickX > renderWidth || clickY < 0 || clickY > renderHeight) {
      setHoverColor(null);
      return;
    }

    const px = Math.floor((clickX / renderWidth) * img.naturalWidth);
    const py = Math.floor((clickY / renderHeight) * img.naturalHeight);
    
    const canvas = offscreenCanvasRef.current;
    if (canvas.width === 0) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    try {
        const pixelData = ctx.getImageData(px, py, 1, 1).data;
        const [r, g, b] = pixelData;
        const hex = viewMode === 'original' ? rgbToHex(r, g, b) : getPrinterHex(r, g, b, viewMode === 'reactive' ? 'rct' : 'pig');
        setHoverColor({ 
          rgb: [r, g, b], 
          hex, 
          x: e.clientX, 
          y: e.clientY,
          imgX: clickX,
          imgY: clickY,
          renderWidth,
          renderHeight,
          rect
        });
    } catch(err) {
        setHoverColor(null);
    }
  };

  const handleImageClick = () => {
    if (hoverColor) {
      handleColorSelect({ rgb: hoverColor.rgb, hex: hoverColor.hex });
    }
  };

  const downloadProcessedImage = () => {
    const canvas = highlightCanvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `chromashift_${viewMode}_export.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const processImage = () => {
    const img = imageRef.current;
    const canvas = highlightCanvasRef.current;
    const offCanvas = offscreenCanvasRef.current;
    if (!img || !canvas || !offCanvas) return;

    const w = offCanvas.width;
    const h = offCanvas.height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const offCtx = offCanvas.getContext('2d');
    const imageData = offCtx.getImageData(0, 0, w, h);
    const data = imageData.data;

    const targetRgb = selectedColor?.rgb;
    const toleranceSq = 50 * 50;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i+1], b = data[i+2];

      // 1. Apply Simulation
      if (viewMode !== 'original') {
        const cmyk = rgbToCmykObj(r, g, b);
        let adj;
        if (viewMode === 'reactive') {
          adj = { c: clamp(cmyk.c * 1.04), m: clamp(cmyk.m * 0.96), y: clamp(cmyk.y * 0.93), k: clamp(cmyk.k * 1.12) };
          adj = applyTAC(adj, 320);
        } else {
          adj = { c: clamp(cmyk.c * 0.94), m: clamp(cmyk.m * 0.92), y: clamp(cmyk.y * 0.98), k: clamp(cmyk.k * 1.05) };
          adj = applyTAC(adj, 300);
        }
        const out = cmykToRgbObj(adj.c, adj.m, adj.y, adj.k);
        r = out.r; g = out.g; b = out.b;
      }

      // 2. Apply Highlight (if active)
      if (highlightMode && targetRgb) {
        const [tr, tg, tb] = targetRgb;
        const distSq = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
        if (distSq > toleranceSq) {
          r *= 0.3; g *= 0.3; b *= 0.3;
        }
      }

      data[i] = r; data[i+1] = g; data[i+2] = b;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  const exportPS = () => {
    if (!palette.length) return;
    let ps = `%!PS-Adobe-3.0\n%%Title: ChromaShift Swatches\n%%DocumentProcessColors: Cyan Magenta Yellow Black\n`;
    palette.forEach((col, i) => {
      const cmyk = rgbToCmykObj(col.rgb[0], col.rgb[1], col.rgb[2]);
      ps += `${cmyk.c/100} ${cmyk.m/100} ${cmyk.y/100} ${cmyk.k/100} setcmykcolor\n`;
      ps += `newpath 50 ${750 - i*30} moveto 100 ${750 - i*30} lineto 100 ${730 - i*30} lineto 50 ${730 - i*30} lineto closepath fill\n`;
      ps += `0 0 0 1 setcmykcolor /Helvetica findfont 10 scalefont setfont 110 ${735 - i*30} moveto (${col.hex}) show\n`;
    });
    ps += `showpage\n`;
    const blob = new Blob([ps], { type: 'application/postscript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'chromashift_swatches.ps'; a.click();
  };

  const clearHighlight = () => {
    const canvas = highlightCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  return (
    <div className="premium-app">
      {/* Navbar */}
      <nav className="navbar">
        <div className="brand">
          <span className="logo-icon">🎨</span>
          <h1>Chroma Studio</h1>
        </div>
        <div className="nav-tabs">
          <button className={`tab-btn ${mainTab === 'studio' ? 'active' : ''}`} onClick={() => setMainTab('studio')}>Image Analyzer</button>
          <button className={`tab-btn ${mainTab === 'profiler' ? 'active' : ''}`} onClick={() => setMainTab('profiler')}>CMYK Profiler</button>
        </div>
        <div className="nav-actions">
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={(e) => loadFile(e.target.files[0])} 
            style={{ display: 'none' }} 
            accept="image/*" 
          />
          <button className="btn-upload" onClick={() => fileInputRef.current.click()}>
            <i className="icon-upload">📁</i> Upload Image
          </button>
        </div>
      </nav>

      {/* Main Workspace */}
      {mainTab === 'studio' ? (
        <div className="workspace">
          
          {/* Center Canvas Area */}
        <div className="canvas-container">
          {hasImage && (
            <div className="sleek-zoom-controls">
              <button onClick={() => setScale(s => Math.max(0.2, s - 0.2))} title="Zoom Out">-</button>
              <span>{Math.round(scale * 100)}%</span>
              <button onClick={() => setScale(s => Math.min(10, s + 0.2))} title="Zoom In">+</button>
              <div className="divider"></div>
              <button className="reset-btn" onClick={() => setScale(1)} title="Reset Zoom">↺</button>
            </div>
          )}

          {!hasImage ? (
            <div className="upload-placeholder" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
              <div className="placeholder-content">
                <span className="huge-icon">🖼️</span>
                <h2>Drag & Drop your image here</h2>
                <p>or click Upload Image to start analyzing colors</p>
              </div>
            </div>
          ) : (
            <div className="canvas-center-wrapper">
              <div 
                className="image-wrapper" 
                style={{ width: `${scale * 100}%`, height: `${scale * 100}%`, minWidth: '100%', minHeight: '100%' }}
                onMouseMove={handleMouseMove} 
                onMouseLeave={() => setHoverColor(null)} 
                onClick={handleImageClick}
              >
                <img 
                  ref={imageRef} 
                  src={previewSrc} 
                  alt="Workspace" 
                  className="main-image" 
                  onLoad={onImageLoad}
                  crossOrigin="anonymous"
                />
                <canvas 
                  ref={highlightCanvasRef} 
                  className="highlight-canvas" 
                  style={{ display: (highlightMode || viewMode !== 'original') ? 'block' : 'none' }} 
                />
                
                {/* Pencil / Picker Loupe */}
                {hoverColor && !highlightMode && hoverColor.rect && (
                  <div 
                    className="picker-loupe" 
                    style={{ 
                      left: hoverColor.x + 20, 
                      top: hoverColor.y - 20, 
                      backgroundImage: `url(${previewSrc})`,
                      backgroundSize: `${hoverColor.renderWidth * 5}px ${hoverColor.renderHeight * 5}px`,
                      backgroundPosition: `-${hoverColor.imgX * 5 - 40}px -${hoverColor.imgY * 5 - 40}px`
                    }}
                  >
                    <div className="loupe-crosshair"></div>
                    <span className="loupe-hex">{hoverColor.hex}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Bottom Palette Section */}
          <div className="bottom-palette-bar">
            <div className="palette-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                <h3>Image Palette</h3>
                {hasImage && (
                  <div className="sim-selector">
                    <button className={viewMode === 'original' ? 'active' : ''} onClick={() => setViewMode('original')}>ORIGINAL VIEW</button>
                    <button className={viewMode === 'reactive' ? 'active' : ''} onClick={() => setViewMode('reactive')}>REACTIVE VIEW</button>
                    <button className={viewMode === 'pigment' ? 'active' : ''} onClick={() => setViewMode('pigment')}>PIGMENT VIEW</button>
                    {viewMode !== 'original' && (
                      <button className="btn-highlight" onClick={downloadProcessedImage} style={{ marginLeft: '10px', background: '#00C9B1' }}>
                        📥 Download Simulated Image
                      </button>
                    )}
                  </div>
                )}
              </div>
              {palette.length > 0 && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-highlight" onClick={exportPS}>
                    💾 Export Swatches (.ps)
                  </button>
                  <button 
                    className={`btn-highlight ${highlightMode ? 'active' : ''}`}
                    onClick={() => setHighlightMode(!highlightMode)}
                  >
                    {highlightMode ? '👁️ Hide Highlight' : '✨ Highlight Color'}
                  </button>
                </div>
              )}
            </div>
            
            <div className="palette-colors">
              {loading && <div className="loading-spinner"></div>}
              {!loading && palette.length === 0 && <span className="empty-text">No palette extracted yet.</span>}
              {!loading && palette.map((col, idx) => {
                const displayHex = viewMode === 'original' ? col.hex : getPrinterHex(col.rgb[0], col.rgb[1], col.rgb[2], viewMode === 'reactive' ? 'rct' : 'pig');
                return (
                <div key={idx} className="palette-item">
                  <div 
                    className={`palette-swatch ${selectedColor?.hex === col.hex ? 'selected' : ''}`}
                    style={{ backgroundColor: displayHex }}
                    onClick={() => handleColorSelect(col)}
                    title={`Original: ${col.hex} | Sim: ${displayHex}`}
                  ></div>
                  {(selectedColor?.hex === col.hex || viewMode !== 'original') && (
                    <span className="palette-hex-label">{displayHex}</span>
                  )}
                </div>
              )})}
            </div>
          </div>
        </div>

        {/* Right Details Panel */}
        <div className="details-panel">
          <div className="panel-inner">
            <h2>Color Details</h2>
            
            {selectedColor ? (
              <div className="selected-color-info">
                {/* Huge Swatch */}
                <div className="huge-swatch" style={{ backgroundColor: selectedColor.hex }}>
                  <span className="huge-hex">{selectedColor.hex}</span>
                </div>

                {/* Formats Grid */}
                <div className="formats-grid">
                  <div className="format-item">
                    <label>HEX</label>
                    <input type="text" readOnly value={selectedColor.hex} />
                  </div>
                  <div className="format-item">
                    <label>RGB</label>
                    <input type="text" readOnly value={selectedColor.rgb.join(', ')} />
                  </div>
                  <div className="format-item">
                    <label>HSL</label>
                    <input type="text" readOnly value={rgbToHsl(...selectedColor.rgb)} />
                  </div>
                  <div className="format-item">
                    <label>CMYK</label>
                    <input type="text" readOnly value={rgbToCmyk(...selectedColor.rgb)} />
                  </div>
                </div>

                {/* Color Matrix */}
                <div className="shades-section">
                  <div className="shades-header-split">
                    <h3>Color Variations</h3>
                    <div className="matrix-tabs">
                      <button className={matrixTab === 'original' ? 'active' : ''} onClick={() => setMatrixTab('original')}>ORIGINAL</button>
                      <button className={matrixTab === 'rct' ? 'active' : ''} onClick={() => setMatrixTab('rct')}>REACTIVE</button>
                      <button className={matrixTab === 'pig' ? 'active' : ''} onClick={() => setMatrixTab('pig')}>PIGMENT</button>
                    </div>
                  </div>

                  {colorDetails?.shades ? (
                    <div className="shades-matrix">
                      {colorDetails.shades.map((row, rIdx) => (
                        <div key={rIdx} className="shades-row">
                          {row.map((shade, cIdx) => {
                            const sRgb = shade.rgb || hexToRgbArr(shade.hex);
                            const displayHex = matrixTab === 'original' ? shade.hex : getPrinterHex(sRgb[0], sRgb[1], sRgb[2], matrixTab);
                            
                            return (
                            <div 
                              key={cIdx} 
                              className={`shade-box-grid ${shade.is_base ? 'base-shade' : ''}`}
                              style={{ backgroundColor: displayHex }}
                              title={`Original: ${shade.hex}\nOutput: ${displayHex}`}
                              onClick={() => copyToClipboard(displayHex)}
                            >
                              <span className="shade-hex-label">
                                {copiedHex === displayHex ? 'COPIED' : displayHex}
                              </span>
                            </div>
                          )})}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="loading-pulse"></div>
                  )}
                </div>
              </div>
            ) : (
              <div className="empty-details">
                <span className="icon">💧</span>
                <p>Select a color from the image or palette to view details.</p>
              </div>
            )}
          </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <TextileColorToolkit initialRgb={selectedColor?.rgb} />
        </div>
      )}
    </div>
  );
}
