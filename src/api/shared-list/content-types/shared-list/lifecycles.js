'use strict';

const { randomBytes } = require('crypto');

const slugify = (str) =>
  String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

// 8 url-safe characters from 6 random bytes — ~48 bits of entropy.
const randomSuffix = () => randomBytes(6).toString('base64url').slice(0, 8);

module.exports = {
  async beforeCreate(event) {
    const { data } = event.params;
    if (!data.slug) {
      const base = slugify(data.name) || 'list';
      data.slug = `${base}-${randomSuffix()}`;
    }
  },
};
