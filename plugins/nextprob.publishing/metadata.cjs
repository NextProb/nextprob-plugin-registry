'use strict';
const MAX_VALUE_LENGTH = 10000;
function ownValue(data, key) { return data && Object.hasOwn(data, key) ? data[key] : undefined; }
function truthy(value) { return !!value; }
function boundedScalar(value) { return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= MAX_VALUE_LENGTH); }
function publicationMetadata(data) {
  const shareId = ownValue(data, '__shareId');
  if (!truthy(shareId)) return null;
  // Malformed objects still count as truthy, but must not retain arbitrary KV payloads.
  const shareUrl = ownValue(data, '__shareUrl');
  const visibility = ownValue(data, '__shareVisibility');
  return { shareId: boundedScalar(shareId) ? shareId : null,
    shareUrl: typeof shareUrl === 'string' && boundedScalar(shareUrl) ? shareUrl : null,
    visibility: typeof visibility === 'string' && visibility && boundedScalar(visibility) ? visibility : 'secret' };
}

module.exports = { keys: ['__shareId', '__shareUrl', '__shareVisibility'], project: publicationMetadata };
