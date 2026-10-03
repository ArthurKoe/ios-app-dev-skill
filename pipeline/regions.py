"""Region catalogue for the relief-map data pipeline.

Every region is a whole-degree bounding box (south, west, north, east) that is
filled with Copernicus GLO-90 (90 m) data.  Regions may additionally carry
GLO-30 (30 m) "detail" data, either for the whole box or for a list of
1-degree cells.  For the Alps the 30 m layer is restricted to mountainous
chunks (see build.py) to keep the repository at a sane size.

Presets are named map frames: centre lat/lon, width and height in km.
"""

# fmt: off
REGIONS = [
    {
        "id": "alps", "name": "The Alps", "group": "Europe",
        "subtitle": "The whole Alpine arc from Nice to Vienna, incl. Jura and Prealps",
        "bounds": [43, 4, 49, 17],
        "glo30": "mountains",
        "presets": [
            ["The whole Alps", 45.95, 10.75, 900, 520],
            ["Western Alps", 45.55, 7.05, 260, 300],
            ["Swiss Alps", 46.55, 8.35, 300, 180],
            ["Eastern Alps (Tyrol)", 47.05, 11.6, 260, 150],
            ["Mont Blanc massif", 45.86, 6.90, 40, 30],
            ["Matterhorn & Monte Rosa", 45.96, 7.76, 30, 22],
            ["Pennine Alps (Valais)", 46.05, 7.55, 110, 60],
            ["Bernese Oberland - Eiger, Mönch & Jungfrau", 46.53, 8.0, 45, 35],
            ["Aletsch Glacier", 46.47, 8.04, 25, 20],
            ["Dolomites", 46.52, 11.95, 75, 55],
            ["Großglockner & Hohe Tauern", 47.08, 12.65, 60, 40],
            ["Ortler, Stelvio & Bernina", 46.45, 10.2, 90, 50],
            ["Engadin & St. Moritz", 46.5, 9.85, 40, 30],
            ["Lake Como & Lake Lugano", 46.0, 9.2, 70, 60],
            ["Lake Garda", 45.68, 10.72, 50, 70],
            ["Lake Geneva & Chablais", 46.35, 6.6, 90, 60],
            ["Lake Lucerne & Central Switzerland", 46.98, 8.5, 50, 40],
            ["Säntis & Lake Constance", 47.45, 9.4, 80, 60],
            ["Écrins massif", 44.92, 6.36, 50, 40],
            ["Gran Paradiso", 45.52, 7.27, 40, 30],
            ["Monte Viso", 44.67, 7.09, 30, 30],
            ["Zugspitze & Wetterstein", 47.42, 10.99, 40, 30],
            ["Berchtesgaden & Watzmann", 47.56, 12.92, 35, 30],
            ["Julian Alps & Triglav", 46.38, 13.84, 50, 40],
        ],
    },
    {
        "id": "himalaya", "name": "Central Himalaya", "group": "Asia",
        "subtitle": "Annapurna to Kangchenjunga; 30 m detail around Everest",
        "bounds": [27, 83, 30, 89],
        "glo30": [[27, 86], [27, 87], [28, 86], [28, 87]],
        "presets": [
            ["Mount Everest close-up", 27.988, 86.925, 15, 12],
            ["Everest, Lhotse & Nuptse", 27.97, 86.9, 25, 20],
            ["Khumbu - Cho Oyu to Makalu", 27.95, 86.88, 70, 50],
            ["Annapurna & Dhaulagiri", 28.65, 83.7, 70, 45],
            ["Kangchenjunga", 27.7, 88.15, 40, 30],
            ["Central Himalaya", 28.4, 86.0, 560, 300],
        ],
    },
    {
        "id": "karakoram", "name": "Karakoram", "group": "Asia",
        "subtitle": "K2, the Baltoro Glacier and Nanga Parbat",
        "bounds": [35, 74, 37, 78],
        "presets": [
            ["K2 & Baltoro Glacier", 35.8, 76.5, 50, 35],
            ["Nanga Parbat", 35.24, 74.59, 40, 30],
            ["Hunza Valley", 36.3, 74.6, 60, 40],
            ["Karakoram", 36.0, 76.0, 340, 210],
        ],
    },
    {
        "id": "caucasus", "name": "Greater Caucasus", "group": "Asia",
        "subtitle": "Elbrus, Ushba and Kazbek",
        "bounds": [42, 41, 44, 46],
        "presets": [
            ["Mount Elbrus", 43.35, 42.44, 30, 25],
            ["Svaneti & Ushba", 43.1, 42.65, 40, 30],
            ["Kazbek", 42.7, 44.52, 30, 25],
            ["Central Caucasus", 43.0, 43.0, 200, 100],
        ],
    },
    {
        "id": "fuji", "name": "Mount Fuji", "group": "Asia",
        "subtitle": "Japan's iconic stratovolcano at 30 m",
        "bounds": [35, 138, 36, 139],
        "glo30": "all",
        "presets": [
            ["Mount Fuji", 35.36, 138.73, 40, 35],
            ["Fuji Five Lakes", 35.45, 138.7, 50, 40],
        ],
    },
    {
        "id": "pyrenees", "name": "Pyrenees", "group": "Europe",
        "subtitle": "From the Basque coast to the Mediterranean",
        "bounds": [42, -2, 44, 4],
        "presets": [
            ["Pyrenees", 42.7, 0.8, 420, 150],
            ["Aneto & Maladeta", 42.63, 0.66, 30, 25],
            ["Ordesa & Monte Perdido", 42.67, 0.03, 30, 25],
            ["Andorra", 42.55, 1.58, 40, 35],
        ],
    },
    {
        "id": "tatra", "name": "Tatra Mountains", "group": "Europe",
        "subtitle": "High Tatras on the Slovak-Polish border at 30 m",
        "bounds": [49, 19, 50, 21],
        "glo30": "all",
        "presets": [
            ["High Tatras", 49.18, 20.1, 40, 25],
            ["Tatra Mountains", 49.2, 19.95, 80, 45],
        ],
    },
    {
        "id": "corsica", "name": "Corsica", "group": "Europe",
        "subtitle": "A mountain range rising from the Mediterranean",
        "bounds": [41, 8, 43, 10],
        "presets": [
            ["Corsica", 42.15, 9.05, 110, 190],
            ["Monte Cinto & Restonica", 42.3, 8.95, 40, 35],
        ],
    },
    {
        "id": "norway", "name": "Norwegian Fjords", "group": "Europe",
        "subtitle": "Jotunheimen, Geirangerfjord and Sognefjord",
        "bounds": [61, 5, 63, 9],
        "presets": [
            ["Geirangerfjord", 62.1, 7.1, 40, 30],
            ["Jotunheimen", 61.6, 8.4, 60, 45],
            ["Western fjords", 61.9, 7.0, 200, 160],
        ],
    },
    {
        "id": "iceland", "name": "Iceland", "group": "Europe",
        "subtitle": "The whole island with its ice caps",
        "bounds": [63, -25, 67, -13],
        "presets": [
            ["Iceland", 64.95, -18.6, 520, 360],
            ["Vatnajökull", 64.4, -16.8, 160, 110],
        ],
    },
    {
        "id": "tenerife", "name": "Tenerife & Teide", "group": "Africa",
        "subtitle": "Volcanic island in the Atlantic at 30 m",
        "bounds": [28, -17, 29, -16],
        "glo30": "all",
        "presets": [
            ["Tenerife & Teide", 28.27, -16.6, 90, 70],
            ["Teide caldera", 28.26, -16.64, 25, 20],
        ],
    },
    {
        "id": "kilimanjaro", "name": "Kilimanjaro", "group": "Africa",
        "subtitle": "Africa's highest mountain at 30 m",
        "bounds": [-4, 37, -2, 38],
        "glo30": "all",
        "presets": [
            ["Kilimanjaro", -3.07, 37.36, 60, 50],
            ["Kibo crater", -3.07, 37.355, 12, 10],
        ],
    },
    {
        "id": "canadian-rockies", "name": "Canadian Rockies", "group": "North America",
        "subtitle": "Banff, Lake Louise and the Columbia Icefield",
        "bounds": [50, -118, 53, -115],
        "presets": [
            ["Moraine Lake & Valley of the Ten Peaks", 51.32, -116.18, 15, 12],
            ["Banff & Lake Louise", 51.35, -116.0, 60, 45],
            ["Mount Assiniboine", 50.87, -115.65, 30, 25],
            ["Columbia Icefield", 52.17, -117.3, 40, 30],
        ],
    },
    {
        "id": "cascades", "name": "Cascade Volcanoes", "group": "North America",
        "subtitle": "Mount Rainier, Mount St. Helens and Mount Adams at 30 m",
        "bounds": [46, -123, 47, -121],
        "glo30": "all",
        "presets": [
            ["Mount Rainier", 46.85, -121.76, 30, 25],
            ["Mount St. Helens", 46.2, -122.19, 15, 12],
            ["Rainier, St. Helens & Adams", 46.5, -121.85, 110, 90],
        ],
    },
    {
        "id": "sierra-nevada", "name": "Sierra Nevada", "group": "North America",
        "subtitle": "Yosemite, Mount Whitney and Lake Tahoe; 30 m around Yosemite",
        "bounds": [36, -121, 40, -118],
        "glo30": [[37, -120]],
        "presets": [
            ["Yosemite Valley", 37.73, -119.57, 15, 10],
            ["Yosemite National Park", 37.85, -119.5, 60, 50],
            ["Mount Whitney", 36.58, -118.3, 25, 20],
            ["Lake Tahoe", 39.1, -120.05, 45, 55],
        ],
    },
    {
        "id": "grand-canyon", "name": "Grand Canyon", "group": "North America",
        "subtitle": "The canyon and the Colorado Plateau; 30 m along the main gorge",
        "bounds": [35, -114, 37, -111],
        "glo30": [[36, -113], [36, -112]],
        "presets": [
            ["Grand Canyon Village", 36.1, -112.1, 40, 30],
            ["Grand Canyon", 36.2, -112.6, 180, 100],
            ["Horseshoe Bend", 36.88, -111.51, 20, 15],
        ],
    },
    {
        "id": "denali", "name": "Alaska Range - Denali", "group": "North America",
        "subtitle": "North America's highest peak",
        "bounds": [62, -152, 64, -149],
        "presets": [
            ["Denali", 63.07, -151.0, 50, 40],
            ["Alaska Range", 63.1, -150.5, 120, 90],
        ],
    },
    {
        "id": "hawaii", "name": "Island of Hawaiʻi", "group": "Oceania",
        "subtitle": "Mauna Kea, Mauna Loa and Kīlauea at 30 m",
        "bounds": [18, -157, 21, -154],
        "glo30": "all",
        "presets": [
            ["Island of Hawaiʻi", 19.6, -155.5, 150, 150],
            ["Mauna Kea & Mauna Loa", 19.6, -155.5, 80, 80],
            ["Kīlauea", 19.4, -155.27, 30, 25],
        ],
    },
    {
        "id": "new-zealand", "name": "Southern Alps (New Zealand)", "group": "Oceania",
        "subtitle": "Aoraki / Mount Cook, Mount Aspiring and Milford Sound",
        "bounds": [-45, 167, -42, 172],
        "presets": [
            ["Aoraki / Mount Cook", -43.6, 170.15, 35, 30],
            ["Mount Aspiring", -44.38, 168.73, 30, 25],
            ["Milford Sound", -44.65, 167.92, 25, 20],
            ["Southern Alps (central)", -43.6, 170.3, 180, 120],
        ],
    },
    {
        "id": "patagonia", "name": "Patagonia", "group": "South America",
        "subtitle": "Fitz Roy, Cerro Torre and Torres del Paine",
        "bounds": [-52, -74, -48, -72],
        "presets": [
            ["Fitz Roy & Cerro Torre", -49.28, -73.06, 25, 20],
            ["Torres del Paine", -50.98, -73.0, 35, 30],
            ["Southern Patagonian Ice Field", -49.9, -73.4, 110, 200],
        ],
    },
    {
        "id": "aconcagua", "name": "Aconcagua (Andes)", "group": "South America",
        "subtitle": "The highest peak outside Asia",
        "bounds": [-34, -71, -32, -69],
        "presets": [
            ["Aconcagua", -32.65, -70.01, 30, 25],
            ["Andes between Mendoza and Santiago", -33.0, -70.0, 150, 120],
        ],
    },
]
# fmt: on

# Famous places outside the stored regions; the app uses live AWS terrain tiles for these.
WORLD_PRESETS = [
    ["Mount Etna", 37.75, 14.99, 40, 35],
    ["Vesuvius & Bay of Naples", 40.75, 14.35, 50, 40],
    ["Mount Olympus (Greece)", 40.085, 22.358, 35, 30],
    ["Scottish Highlands - Glencoe & Ben Nevis", 56.75, -5.0, 50, 40],
    ["Lofoten", 68.2, 14.3, 90, 50],
    ["Atlas - Toubkal", 31.06, -7.92, 40, 30],
    ["Drakensberg", -28.75, 29.0, 60, 45],
    ["Table Mountain & Cape Peninsula", -34.15, 18.43, 45, 60],
    ["Mount Kenya", -0.15, 37.31, 40, 35],
    ["Mount Ararat", 39.70, 44.30, 50, 40],
    ["Mount Kailash", 31.067, 81.312, 40, 30],
    ["Huangshan (Yellow Mountains)", 30.13, 118.17, 25, 20],
    ["Yellowstone & Grand Teton", 44.2, -110.7, 150, 160],
    ["Rocky Mountain National Park", 40.35, -105.68, 45, 40],
    ["Zion National Park", 37.25, -112.95, 30, 25],
    ["Crater Lake", 42.94, -122.1, 25, 20],
    ["Mount Hood", 45.37, -121.7, 30, 25],
    ["Machu Picchu & Salkantay", -13.25, -72.5, 45, 35],
    ["Chimborazo", -1.47, -78.82, 35, 30],
    ["Mount Cook to the sea (Westland)", -43.5, 170.0, 80, 60],
]
