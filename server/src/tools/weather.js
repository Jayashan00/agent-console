import { defineTool, httpGet, ToolError } from './toolkit.js';

/**
 * get_weather — a real third-party API call (Open-Meteo, keyless) in two hops:
 * geocode the place name, then pull the forecast for those coordinates. It is
 * here to prove the agent can chain dependent API calls and surface a specific,
 * actionable error when the first hop finds nothing.
 */

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle', 61: 'Slight rain', 63: 'Moderate rain',
  65: 'Heavy rain', 71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 80: 'Rain showers',
  81: 'Moderate rain showers', 82: 'Violent rain showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail',
};

export default defineTool({
  name: 'get_weather',
  title: 'Get the weather',
  category: 'api',
  description:
    'Look up current conditions and a daily forecast for a place by name, via the Open-Meteo public API. Returns temperatures in Celsius.',
  parameters: {
    location: { type: 'string', required: true, description: 'Place name, e.g. "Colombo" or "Berlin, Germany".' },
    days: { type: 'number', required: false, default: 3, min: 1, max: 7, description: 'Days of forecast to include.' },
  },
  returns: 'Resolved place, current conditions, and a day-by-day forecast.',
  signature: (input) => `get_weather("${input.location ?? ''}")`,

  async run({ location, days = 3 }, ctx) {
    ctx.progress(`Geocoding "${location}"`);
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(location)}`;
    const geo = JSON.parse((await httpGet(geoUrl, { progress: ctx.progress })).body);
    const place = geo?.results?.[0];
    if (!place) {
      throw new ToolError(`Open-Meteo could not find a place called "${location}". Try adding a country, e.g. "Kandy, Sri Lanka".`, {
        kind: 'not_found',
        retriable: true,
      });
    }

    ctx.progress(`Fetching forecast for ${place.name}, ${place.country}`);
    const forecastUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      `&timezone=auto&forecast_days=${days}`;
    const data = JSON.parse((await httpGet(forecastUrl, { progress: ctx.progress })).body);

    const daily = (data.daily?.time ?? []).map((date, i) => ({
      date,
      conditions: WEATHER_CODES[data.daily.weather_code[i]] ?? `Code ${data.daily.weather_code[i]}`,
      maxC: data.daily.temperature_2m_max[i],
      minC: data.daily.temperature_2m_min[i],
      precipitationChance: `${data.daily.precipitation_probability_max?.[i] ?? 0}%`,
    }));

    return {
      place: `${place.name}, ${place.admin1 ? place.admin1 + ', ' : ''}${place.country}`,
      coordinates: { latitude: place.latitude, longitude: place.longitude },
      timezone: data.timezone,
      current: {
        temperatureC: data.current?.temperature_2m,
        humidity: `${data.current?.relative_humidity_2m}%`,
        windSpeedKmh: data.current?.wind_speed_10m,
        conditions: WEATHER_CODES[data.current?.weather_code] ?? 'Unknown',
      },
      forecast: daily,
    };
  },
});
