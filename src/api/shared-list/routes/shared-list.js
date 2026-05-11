'use strict';

// No default REST CRUD is exposed for shared-list. Public reads use the
// custom slug route below; admin operations live under /api/admin/shared-lists
// and run through the admin policy stack.
module.exports = { routes: [] };
