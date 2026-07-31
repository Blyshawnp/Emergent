export function normalizeHeadsetPart(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function normalizeHeadsetIdentity(brand, model) {
  return `${normalizeHeadsetPart(brand)}\u0000${normalizeHeadsetPart(model)}`.toLocaleLowerCase();
}

export function buildHeadsetDisplayLabel(brand, model, combined = '') {
  const normalizedBrand = normalizeHeadsetPart(brand);
  const normalizedModel = normalizeHeadsetPart(model);
  const normalizedCombined = normalizeHeadsetPart(combined);
  if (!normalizedBrand && !normalizedModel) return normalizedCombined;
  if (!normalizedBrand) return normalizedModel;
  if (!normalizedModel) return normalizedBrand;
  const brandKey = normalizedBrand.toLocaleLowerCase();
  const modelKey = normalizedModel.toLocaleLowerCase();
  if (modelKey === brandKey || modelKey.startsWith(`${brandKey} `)) return normalizedModel;
  return `${normalizedBrand} ${normalizedModel}`;
}

export function getCandidateHeadset(record = {}) {
  const model = normalizeHeadsetPart(
    record.headset_model || record.HeadsetModel || record.Model || record.model,
  );
  const brand = normalizeHeadsetPart(
    record.headset_brand || record.HeadsetBrand || record.Brand || record.brand,
  );
  if (model) {
    return { brand, model, label: buildHeadsetDisplayLabel(brand, model), separate: true };
  }
  return { brand: '', model: '', label: brand, separate: false };
}
