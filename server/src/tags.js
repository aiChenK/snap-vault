const { ApiError } = require('./errors');

function tagText(input, maxLength, label) {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > maxLength) {
    throw new ApiError(400, `Invalid ${label} (1–${maxLength} characters)`);
  }
  return input.trim();
}

function effectiveValue(tag) {
  if (Object.hasOwn(tag, 'manual')) return tag.manual;
  return tag.auto?.status === 'ok' ? tag.auto.value : null;
}

function galleryTags(tags) {
  return tags.map(tag => ({ ...tag, value: effectiveValue(tag) }));
}

function readFilters(raw) {
  if (raw === undefined) return [];
  let filters;
  try {
    filters = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'Invalid tags filter');
  }
  if (!Array.isArray(filters)) throw new ApiError(400, 'Expected an array of tag filters');
  return filters.map(filter => ({
    category: tagText(filter?.category, 64, 'category'),
    value: tagText(filter?.value, 128, 'value'),
  }));
}

function readReport(body, plugins) {
  const plugin = plugins.find(p => p.id === body.plugin);
  if (!plugin || body.version !== plugin.version) {
    throw new ApiError(409, '插件已变更，请刷新画廊');
  }
  const { status } = body;
  if (!['ok', 'low_conf', 'no_match', 'err'].includes(status)) {
    throw new ApiError(400, 'Invalid recognition status');
  }
  const auto = { plugin: plugin.id, version: plugin.version, status };
  if (status === 'ok' || status === 'low_conf') auto.value = tagText(body.value, 128, 'value');
  if (status === 'err') auto.error = tagText(body.error, 500, 'error');
  return { category: plugin.category, auto };
}

module.exports = { tagText, galleryTags, readFilters, readReport };
