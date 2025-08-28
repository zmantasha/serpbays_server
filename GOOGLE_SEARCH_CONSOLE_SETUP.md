# Google Search Console Integration Setup

This document explains how to set up Google Search Console verification for publisher website verification.

## 1. Google Cloud Console Setup

### Create OAuth 2.0 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Search Console API**:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Search Console API"
   - Click "Enable"

4. Create OAuth 2.0 credentials:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Choose "Web application"
   - Add authorized redirect URIs:
     - `http://localhost:3000/api/auth/google-search-console/callback` (for development)
     - `https://yourdomain.com/api/auth/google-search-console/callback` (for production)

## 2. Environment Variables

Add these environment variables to your `.env.local` file:

### Frontend (.env.local)
```
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your_google_client_id_here
NEXT_PUBLIC_GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google-search-console/callback
```

### Backend (.env)
```
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google-search-console/callback
```

## 3. How It Works

### Verification Flow

1. **User Input**: Publisher enters their website URL
2. **OAuth Popup**: Clicking "Connect Google Search Console" opens OAuth popup
3. **Permission Request**: Google asks for Search Console read access
4. **Token Exchange**: System exchanges authorization code for access token
5. **Ownership Verification**: API checks if user owns/has access to the website
6. **Result**: Success or error message is returned

### Technical Implementation

#### Frontend
- **OAuth Popup**: Opens Google OAuth in popup window
- **Message Listener**: Listens for success/error messages from popup
- **UI Updates**: Shows loading states, success, and error messages

#### Backend
- **Callback Handler**: Processes OAuth callback and exchanges tokens
- **API Verification**: Calls Google Search Console API to verify ownership
- **Database Storage**: Should store verification status and tokens

### Required Permissions

Users must have one of these permission levels in Google Search Console:
- **Site Owner**: Full ownership of the website
- **Full User**: Complete access to all data and settings

### Security Features

- **State Parameter**: Prevents CSRF attacks by encoding website URL
- **Origin Validation**: Only accepts messages from same origin
- **Token Security**: Access tokens are not exposed to frontend
- **Error Handling**: Comprehensive error messages for different failure scenarios

## 4. Database Schema

You should extend your website/marketplace schema to include:

```sql
-- Add verification fields to marketplace table
ALTER TABLE marketplace ADD COLUMN gsc_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE marketplace ADD COLUMN gsc_verified_at TIMESTAMP;
ALTER TABLE marketplace ADD COLUMN gsc_permission_level VARCHAR(50);
ALTER TABLE marketplace ADD COLUMN gsc_refresh_token TEXT; -- Store securely/encrypted
```

## 5. Future Enhancements

### Data Collection
With verified Search Console access, you can collect:
- **Search Performance**: Clicks, impressions, CTR, average position
- **Coverage Data**: Indexed pages, crawl errors
- **Core Web Vitals**: Page experience metrics
- **Mobile Usability**: Mobile-friendly issues

### Rating Improvements
As mentioned in the UI:
- **+2.5% rating** for Search Console verification
- **+10% total rating** when combined with Google Analytics

### API Endpoints to Add
```
GET /api/search-console/performance/:websiteId
GET /api/search-console/coverage/:websiteId
GET /api/search-console/vitals/:websiteId
```

## 6. Error Handling

Common errors and solutions:

### "Website not found in Google Search Console"
- User needs to add website to Search Console first
- Provide link to Search Console with instructions

### "Access denied"
- User doesn't have sufficient permissions
- Guide them to request access from website owner

### "OAuth not configured"
- Missing environment variables
- Check Google Cloud Console setup

## 7. Testing

### Development Testing
1. Set up test website in Google Search Console
2. Use localhost redirect URI
3. Test with different permission levels
4. Verify error handling scenarios

### Production Deployment
1. Update redirect URIs in Google Cloud Console
2. Set production environment variables
3. Test with real websites
4. Monitor error rates and user feedback

