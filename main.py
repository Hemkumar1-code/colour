from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
import cv2
import numpy as np
from sklearn.cluster import KMeans
import colorsys
import io

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def rgb_to_hex(r, g, b):
    return "#{:02x}{:02x}{:02x}".format(r, g, b).upper()

def get_dominant_colors(image_bytes, k=5):
    # Decode image
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    
    # Resize for speed and easy percentage mapping
    img = cv2.resize(img, (100, 100))
    pixels = img.reshape(-1, 3)
    
    kmeans = KMeans(n_clusters=k, n_init=10)
    kmeans.fit(pixels)
    
    colors = kmeans.cluster_centers_.astype(int)
    counts = np.bincount(kmeans.labels_)
    
    # Sort by frequency
    sorted_indices = np.argsort(counts)[::-1]
    
    results = []
    for idx in sorted_indices:
        color = colors[idx]
        # Find the actual pixel closest to this cluster center to get its coordinate
        distances = np.linalg.norm(pixels - color, axis=1)
        closest_idx = np.argmin(distances)
        y = closest_idx // 100
        x = closest_idx % 100
        
        results.append({
            "rgb": (int(color[0]), int(color[1]), int(color[2])),
            "pos": {"x": int(x), "y": int(y)} # 0-100 percentage
        })
        
    return results

def apply_fabric_correction(r, g, b, fabric_type):
    # Convert RGB to HSL
    # colorsys expects values between 0.0 and 1.0
    h, l, s = colorsys.rgb_to_hls(r/255.0, g/255.0, b/255.0)
    
    if fabric_type == "Interlock":
        # reduce brightness & saturation (darker output)
        l = max(0, l - 0.1)
        s = max(0, s - 0.1)
    elif fabric_type == "Satin":
        # increase brightness & saturation (shiny output)
        l = min(1.0, l + 0.15)
        s = min(1.0, s + 0.15)
    elif fabric_type == "Muslin":
        # soft/pastel effect
        l = min(1.0, l + 0.1)
        s = max(0, s - 0.15)
    elif fabric_type == "Twill":
        # slightly darker tones
        l = max(0, l - 0.05)
    
    # Convert back to RGB
    r_corr, g_corr, b_corr = colorsys.hls_to_rgb(h, l, s)
    return int(r_corr*255), int(g_corr*255), int(b_corr*255)

def get_color_family(h, s, l):
    h_deg = h * 360
    if l < 0.15: return "Black"
    if l > 0.85: return "White"
    if s < 0.15: return "Gray"
    
    if h_deg < 15 or h_deg >= 345: return "Red"
    if 15 <= h_deg < 45: return "Orange"
    if 45 <= h_deg < 75: return "Yellow"
    if 75 <= h_deg < 150: return "Green"
    if 150 <= h_deg < 210: return "Cyan/Teal"
    if 210 <= h_deg < 260: return "Blue"
    if 260 <= h_deg < 315: return "Purple"
    if 315 <= h_deg < 345: return "Pink"
    
    return "Unknown"

def generate_shades(r, g, b):
    h, l, s = colorsys.rgb_to_hls(r/255.0, g/255.0, b/255.0)
    shades = []
    
    # Create a 9x16 matrix
    lightnesses = np.linspace(0.95, 0.05, 16)
    saturations = np.linspace(1.0, 0.1, 9)
    
    closest_l_idx = np.argmin(np.abs(lightnesses - l))
    closest_s_idx = np.argmin(np.abs(saturations - s))
    
    for sat_idx, sat in enumerate(saturations):
        row = []
        for light_idx, light in enumerate(lightnesses):
            actual_sat = float(s) if sat_idx == int(closest_s_idx) else float(sat)
            actual_light = float(l) if light_idx == int(closest_l_idx) else float(light)
            
            sr, sg, sb = colorsys.hls_to_rgb(h, actual_light, actual_sat)
            row.append({
                "hex": rgb_to_hex(int(sr*255), int(sg*255), int(sb*255)),
                "rgb": (int(sr*255), int(sg*255), int(sb*255)),
                "is_base": bool(sat_idx == int(closest_s_idx) and light_idx == int(closest_l_idx))
            })
        shades.append(row)
        
    shades_strip = []
    strip_lightnesses = np.linspace(0.95, 0.05, 20)
    for light in strip_lightnesses:
        sr, sg, sb = colorsys.hls_to_rgb(h, light, s)
        shades_strip.append({
            "hex": rgb_to_hex(int(sr*255), int(sg*255), int(sb*255)),
            "rgb": (int(sr*255), int(sg*255), int(sb*255))
        })
        
    return shades, shades_strip

FABRIC_MACHINES = {
    "Twill": "Homer",
    "Interlock": "Textalk 2032, Textalk 1824",
    "Muslin": "Textalk 2032, Textalk 1824",
    "Satin": "Textalk 2032, Textalk 1824",
    "Single Jersey / Lycra Jersey": "Textalk + Homer",
    "Loopnet": "Textalk + Homer",
    "Rib": "Textalk + Homer"
}

@app.post("/analyze")
async def analyze_fabric(file: UploadFile = File(...), fabricType: str = Form(...)):
    image_bytes = await file.read()
    
    # 1. Extract dominant colors (returns dicts with rgb and pos)
    dominant_data = get_dominant_colors(image_bytes, k=8)
    
    # 2. Extract main color (most dominant)
    main_r, main_g, main_b = dominant_data[0]["rgb"]
    
    return process_color_logic(main_r, main_g, main_b, fabricType, dominant_data)

@app.post("/process-color")
async def process_manual_color(
    r: int = Form(...), 
    g: int = Form(...), 
    b: int = Form(...), 
    fabricType: str = Form(...)
):
    return process_color_logic(r, g, b, fabricType)

def process_color_logic(r, g, b, fabricType, palette_colors=None):
    # 1. Apply fabric correction
    corr_r, corr_g, corr_b = apply_fabric_correction(r, g, b, fabricType)
    
    # 2. Color family
    h, l, s = colorsys.rgb_to_hls(corr_r/255.0, corr_g/255.0, corr_b/255.0)
    family = get_color_family(h, s, l)
    
    # 3. Generate shades
    shades, shades_strip = generate_shades(corr_r, corr_g, corr_b)
    
    # 4. Build palette
    palette = []
    if palette_colors:
        # Check if palette colors have 'pos' (from analyze) or just tuples (not expected but safe)
        for p in palette_colors:
            if isinstance(p, dict):
                pr, pg, pb = p["rgb"]
                pos = p.get("pos")
            else:
                pr, pg, pb = p
                pos = None
            palette.append({
                "hex": rgb_to_hex(pr, pg, pb), 
                "rgb": [int(pr), int(pg), int(pb)],
                "pos": pos
            })
    
    return {
        "original_color": {
            "hex": rgb_to_hex(r, g, b),
            "rgb": [int(r), int(g), int(b)]
        },
        "corrected_color": {
            "hex": rgb_to_hex(corr_r, corr_g, corr_b),
            "rgb": [int(corr_r), int(corr_g), int(corr_b)]
        },
        "color_family": family,
        "machine": FABRIC_MACHINES.get(fabricType, "Unknown"),
        "shades": shades,
        "shades_strip": shades_strip,
        "extracted_palette": palette
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
