'use strict';

/**
 * GET /admin/conversations
 *
 * One row per order that has at least one message: order basics, buyer and
 * publisher (safe fields only), message count, unread count, last message,
 * and a light list of all messages (id, text, time) so the panel's search can
 * match message text. Read-only.
 */
module.exports = {
  async list(ctx) {
    const knex = strapi.db.connection;
    const rows = (await knex.raw(`
      with m as (
        select l.order_id, c.id, c.message, coalesce(c.published_at, c.created_at) as at, c.is_unread
          from communications c
          join communications_order_lnk l on l.communication_id = c.id
      ),
      g as (
        select order_id, count(*)::int as total,
               count(*) filter (where is_unread)::int as unread,
               max(at) as last_at,
               (array_agg(message order by at desc, id desc))[1] as last_message,
               json_agg(json_build_object('id', id, 'message', message, 'createdAt', at) order by at, id) as messages
          from m group by order_id
      )
      select o.id, o.description, o.order_status, o.website_url, o.created_at, o.updated_at,
             g.total, g.unread, g.last_at, g.last_message, g.messages,
             a.id as a_id, a.username as a_username, a.email as a_email, a.first_name as a_first, a.last_name as a_last,
             p.id as p_id, p.username as p_username, p.email as p_email, p.first_name as p_first, p.last_name as p_last
        from g
        join orders o on o.id = g.order_id
        left join orders_advertiser_lnk al on al.order_id = o.id
        left join up_users a on a.id = al.user_id
        left join orders_publisher_lnk pl on pl.order_id = o.id
        left join up_users p on p.id = pl.user_id
       order by g.last_at desc nulls last
       limit 1000`)).rows;

    const person = (r, k) => (r[`${k}_id`] ? { id: r[`${k}_id`], username: r[`${k}_username`], email: r[`${k}_email`], firstName: r[`${k}_first`] || undefined, lastName: r[`${k}_last`] || undefined } : null);
    ctx.send({
      data: rows.map((r) => ({
        orderId: r.id,
        orderTitle: r.description || `Order #${r.id}`,
        orderStatus: r.order_status || 'pending',
        website: r.website_url || null,
        advertiser: person(r, 'a'),
        publisher: person(r, 'p'),
        totalMessages: r.total,
        unread: r.unread,
        lastMessage: r.last_message || '',
        lastActivity: r.last_at || r.updated_at,
        messages: typeof r.messages === 'string' ? JSON.parse(r.messages) : (r.messages || []),
      })),
    });
  },
};
