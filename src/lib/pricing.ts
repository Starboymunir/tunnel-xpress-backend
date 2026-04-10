import { config } from '../config';

/**
 * Calculate delivery fee based on distance.
 * Formula: (baseFee + (distanceKm * perKmFee)) * surgeMultiplier
 */
export function calculateDeliveryFee(distanceKm: number, surgeMultiplier?: number): {
  baseFee: number;
  perKmFee: number;
  surgeMultiplier: number;
  totalFee: number;
} {
  const surge = surgeMultiplier ?? config.pricing.surgeMultiplier;
  const raw = config.pricing.baseFee + distanceKm * config.pricing.perKmFee;
  const totalFee = Math.round(raw * surge);

  return {
    baseFee: config.pricing.baseFee,
    perKmFee: config.pricing.perKmFee,
    surgeMultiplier: surge,
    totalFee,
  };
}

/**
 * Estimate delivery time in minutes based on distance.
 * Assumes ~20 km/h average speed in Lagos traffic + 10 min pickup buffer.
 */
export function estimateDeliveryTime(distanceKm: number): number {
  const avgSpeedKmH = 20;
  const pickupBufferMin = 10;
  return Math.ceil((distanceKm / avgSpeedKmH) * 60) + pickupBufferMin;
}

/**
 * Calculate distance between two coordinates using Haversine formula (km).
 */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
