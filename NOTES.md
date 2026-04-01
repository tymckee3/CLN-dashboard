// Patch: update fetchWx and updateSun to use data.json fields when available
// This patch applies to the dashboard — real sunrise/sunset from AlsoEnergy,
// real weather from AlsoEnergy's weather station

// In fetchData(), after loading data.json, add:
// - Use d.sunrise / d.sunset directly instead of calculating
// - Use d.weather for conditions instead of Open-Meteo

// The scraper now writes these fields to data.json:
// d.sunrise = "6:58 AM MDT"
// d.sunset  = "7:24 PM MDT"  
// d.sunElevation = 50.0
// d.weather = { tempF, condition, windSpeed, icon, forecast[] }
