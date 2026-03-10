// Diagnostic script to analyze escrow balance issue
const axios = require('axios');

async function diagnoseEscrow() {
    try {
        console.log('=== ESCROW BALANCE DIAGNOSTIC ===\n');

        // Get wallet balance
        const walletResponse = await axios.get('http://localhost:1337/api/api/wallet/available-balance', {
            headers: {
                'Authorization': 'Bearer YOUR_TOKEN_HERE' // You'll need to replace this
            }
        });

        const walletData = walletResponse.data.data;
        console.log('WALLET BALANCES:');
        console.log('- Main Balance:', walletData.mainBalance);
        console.log('- Promo Balance:', walletData.promoBalance);
        console.log('- Escrow Balance:', walletData.escrowBalance);
        console.log('- Total Balance:', walletData.totalBalance);
        console.log('- Pending Withdrawal:', walletData.pendingWithdrawalBalance);
        console.log('\n');

        // Get all transactions
        const transactionsResponse = await axios.get('http://localhost:1337/api/api/wallet/transactions', {
            headers: {
                'Authorization': 'Bearer YOUR_TOKEN_HERE' // You'll need to replace this
            }
        });

        const transactions = transactionsResponse.data.data;
        console.log(`TOTAL TRANSACTIONS: ${transactions.length}\n`);

        // Analyze transactions
        const escrowTransactions = transactions.filter(t =>
            t.description?.toLowerCase().includes('escrow') ||
            t.type === 'escrow_hold' ||
            t.type === 'escrow_release'
        );

        console.log(`ESCROW-RELATED TRANSACTIONS: ${escrowTransactions.length}`);
        escrowTransactions.forEach(t => {
            console.log(`- [${t.type}] ${t.description} | Amount: $${t.amount} | Date: ${t.createdAt}`);
        });

    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
    }
}

diagnoseEscrow();
