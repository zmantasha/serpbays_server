
const strapi = require('@strapi/strapi');

async function reproduce() {
    const app = await strapi().load();

    try {
        console.log('--- Starting Notification Reproduction ---');

        // 1. Get the last order
        const orders = await app.entityService.findMany('api::order.order', {
            sort: { id: 'desc' },
            limit: 1,
            populate: ['advertiser', 'publisher']
        });

        if (orders.length === 0) {
            console.log('No orders found to test with.');
            return;
        }

        const order = orders[0];
        console.log(`Testing with Order #${order.id}`);
        console.log(`Advertiser: ${order.advertiser?.id} (${order.advertiser?.email})`);

        // 2. Call the service method explicitly
        console.log('Calling sendCancellationNotifications...');

        try {
            await app.service('api::order.order').sendCancellationNotifications(
                order,
                'advertiser',
                'Test cancellation reason from script'
            );
            console.log('Service method executed successfully.');
        } catch (e) {
            console.error('Service method failed:', e);
        }

        // 3. Verify if notifications exist in DB
        const notifications = await app.entityService.findMany('api::notification.notification', {
            filters: {
                relatedOrderId: order.id,
                type: 'order',
                action: 'order_cancelled'
            },
            sort: { createdAt: 'desc' },
            populate: ['recipient']
        });

        console.log(`Found ${notifications.length} 'order_cancelled' notifications for Order #${order.id}:`);
        notifications.forEach(n => {
            console.log(` - ID: ${n.id}, Recipient: ${n.recipient?.id}, Title: "${n.title}", Msg: "${n.message}"`);
        });

    } catch (error) {
        console.error('Reproduction failed:', error);
    } finally {
        // app.destroy(); // Don't destroy if we want to keep server running (but here we just loaded it)
        process.exit(0);
    }
}

reproduce();
