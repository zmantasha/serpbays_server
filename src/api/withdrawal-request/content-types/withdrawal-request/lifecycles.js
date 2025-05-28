'use strict';

module.exports = {
  async afterUpdate(event) {
    const { result, params } = event;
    // 'result' is the state of the entity AFTER the update.
    // 'params.data' is the data that was sent to the update operation.

    console.log('[LifecycleHook] afterUpdate for withdrawal-request triggered.');
    console.log('[LifecycleHook] Result (entity after update):', JSON.stringify(result, null, 2));
    console.log('[LifecycleHook] Params.data (update payload):', JSON.stringify(params.data, null, 2));

    // We only want to send a notification if the withdrawal_status was part of the fields being updated.
    if (!params.data || typeof params.data.withdrawal_status === 'undefined') {
      console.log('[LifecycleHook] withdrawal_status was not in the update payload (params.data). No status change notification will be sent from lifecycle hook.');
      return;
    }

    const newStatus = result.withdrawal_status;
    console.log(`[LifecycleHook] New status from result: ${newStatus}`);

    if (!result.publisher || !result.amount) {
      console.error('[LifecycleHook] Missing publisher or amount in the updated result. Cannot send notification.', result);
      return;
    }

    let publisherId;
    if (typeof result.publisher === 'object' && result.publisher !== null && result.publisher.id) {
      publisherId = result.publisher.id;
    } else if (typeof result.publisher === 'number' || typeof result.publisher === 'string') {
      publisherId = result.publisher; // Assuming it's the ID directly
    } else {
        // Attempt to fetch the full withdrawal request to get the populated publisher
        try {
            const fullRequest = await strapi.entityService.findOne('api::withdrawal-request.withdrawal-request', result.id, {
                populate: ['publisher']
            });
            if (fullRequest && fullRequest.publisher && fullRequest.publisher.id) {
                publisherId = fullRequest.publisher.id;
                console.log('[LifecycleHook] Fetched full request to get publisher ID:', publisherId);
            } else {
                console.error('[LifecycleHook] Could not determine publisher ID even after fetching full request. Publisher data:', fullRequest ? fullRequest.publisher : 'N/A');
                return;
            }
        } catch (fetchError) {
            console.error('[LifecycleHook] Error fetching full withdrawal request to populate publisher:', fetchError);
            return;
        }
    }

    if (!publisherId) {
        console.error('[LifecycleHook] Final publisherId is undefined. Cannot send notification.');
        return;
    }

    const amount = result.amount;
    let action = null;
    let additionalData = {};

    if (newStatus === 'approved') {
      action = 'withdrawal_approved';
    } else if (newStatus === 'denied') {
      action = 'withdrawal_denied';
      additionalData.reason = result.denialReason || 'Withdrawal was denied by admin.';
    } else if (newStatus === 'paid') {
      action = 'withdrawal_paid';
    }

    if (action) {
      console.log(`[LifecycleHook] Action determined: ${action}. Publisher ID: ${publisherId}, Amount: ${amount}`);
      try {
        await strapi.service('api::notification.notification').createPaymentNotification(
          publisherId,
          action,
          amount,
          null, // orderId
          additionalData
        );
        console.log(`[LifecycleHook] Notification sent successfully for action: ${action} to publisher ${publisherId}.`);
      } catch (error) {
        console.error(`[LifecycleHook] Error sending notification for action ${action} to publisher ${publisherId}:`, error);
      }
    } else {
      console.log(`[LifecycleHook] No action determined for status: ${newStatus}. No notification sent.`);
    }
  },
}; 