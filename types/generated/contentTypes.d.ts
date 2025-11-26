import type { Schema, Struct } from '@strapi/strapi';

export interface AdminApiToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_tokens';
  info: {
    description: '';
    displayName: 'Api Token';
    name: 'Api Token';
    pluralName: 'api-tokens';
    singularName: 'api-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    expiresAt: Schema.Attribute.DateTime;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::api-token'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.Enumeration<['read-only', 'full-access', 'custom']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'read-only'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminApiTokenPermission extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_api_token_permissions';
  info: {
    description: '';
    displayName: 'API Token Permission';
    name: 'API Token Permission';
    pluralName: 'api-token-permissions';
    singularName: 'api-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::api-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::api-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminPermission extends Struct.CollectionTypeSchema {
  collectionName: 'admin_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'Permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    actionParameters: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    conditions: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<[]>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::permission'> &
      Schema.Attribute.Private;
    properties: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<{}>;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<'manyToOne', 'admin::role'>;
    subject: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminRole extends Struct.CollectionTypeSchema {
  collectionName: 'admin_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'Role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::role'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<'oneToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<'manyToMany', 'admin::user'>;
  };
}

export interface AdminTransferToken extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_tokens';
  info: {
    description: '';
    displayName: 'Transfer Token';
    name: 'Transfer Token';
    pluralName: 'transfer-tokens';
    singularName: 'transfer-token';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    accessKey: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }> &
      Schema.Attribute.DefaultTo<''>;
    expiresAt: Schema.Attribute.DateTime;
    lastUsedAt: Schema.Attribute.DateTime;
    lifespan: Schema.Attribute.BigInteger;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminTransferTokenPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_transfer_token_permissions';
  info: {
    description: '';
    displayName: 'Transfer Token Permission';
    name: 'Transfer Token Permission';
    pluralName: 'transfer-token-permissions';
    singularName: 'transfer-token-permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'admin::transfer-token-permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    token: Schema.Attribute.Relation<'manyToOne', 'admin::transfer-token'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface AdminUser extends Struct.CollectionTypeSchema {
  collectionName: 'admin_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'User';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    blocked: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    firstname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    isActive: Schema.Attribute.Boolean &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<false>;
    lastname: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'admin::user'> &
      Schema.Attribute.Private;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    preferedLanguage: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    registrationToken: Schema.Attribute.String & Schema.Attribute.Private;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    roles: Schema.Attribute.Relation<'manyToMany', 'admin::role'> &
      Schema.Attribute.Private;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    username: Schema.Attribute.String;
  };
}

export interface ApiAboutAbout extends Struct.SingleTypeSchema {
  collectionName: 'abouts';
  info: {
    description: 'Write about yourself and the content you create';
    displayName: 'About';
    pluralName: 'abouts';
    singularName: 'about';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    blocks: Schema.Attribute.DynamicZone<
      ['shared.quote', 'shared.rich-text', 'shared.slider']
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::about.about'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    title: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAdminAuditLogAdminAuditLog
  extends Struct.CollectionTypeSchema {
  collectionName: 'admin_audit_logs';
  info: {
    description: 'Track all admin operations for security and compliance';
    displayName: 'Admin Audit Log';
    pluralName: 'admin-audit-logs';
    singularName: 'admin-audit-log';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    action: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 100;
      }>;
    adminUser: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    > &
      Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    details: Schema.Attribute.JSON & Schema.Attribute.Required;
    ipAddress: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 45;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::admin-audit-log.admin-audit-log'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    targetUser: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    userAgent: Schema.Attribute.Text;
  };
}

export interface ApiArticleArticle extends Struct.CollectionTypeSchema {
  collectionName: 'articles';
  info: {
    description: 'Create your blog content';
    displayName: 'Article';
    pluralName: 'articles';
    singularName: 'article';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    author: Schema.Attribute.Relation<'manyToOne', 'api::author.author'>;
    blocks: Schema.Attribute.DynamicZone<
      ['shared.quote', 'shared.rich-text', 'shared.slider']
    >;
    category: Schema.Attribute.Relation<'manyToOne', 'api::category.category'>;
    cover: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 80;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::article.article'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    slug: Schema.Attribute.UID<'title'>;
    title: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAuthAuth extends Struct.CollectionTypeSchema {
  collectionName: 'auths';
  info: {
    description: 'Authentication endpoints';
    displayName: 'Auth';
    pluralName: 'auths';
    singularName: 'auth';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::auth.auth'> &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiAuthorAuthor extends Struct.CollectionTypeSchema {
  collectionName: 'authors';
  info: {
    description: 'Create authors for your content';
    displayName: 'Author';
    pluralName: 'authors';
    singularName: 'author';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    articles: Schema.Attribute.Relation<'oneToMany', 'api::article.article'>;
    avatar: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::author.author'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiBankTransferRequestBankTransferRequest
  extends Struct.CollectionTypeSchema {
  collectionName: 'bank_transfer_requests';
  info: {
    description: 'Bank transfer requests from users';
    displayName: 'Bank Transfer Request';
    pluralName: 'bank-transfer-requests';
    singularName: 'bank-transfer-request';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: true;
    };
    'content-type-builder': {
      visible: true;
    };
  };
  attributes: {
    adminNotes: Schema.Attribute.Text;
    amount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::bank-transfer-request.bank-transfer-request'
    > &
      Schema.Attribute.Private;
    notes: Schema.Attribute.Text;
    proofOfPayment: Schema.Attribute.Media<'images'> &
      Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    referenceNumber: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    status: Schema.Attribute.Enumeration<
      ['pending', 'processing', 'completed', 'rejected']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'pending'>;
    transactionId: Schema.Attribute.String & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    userEmail: Schema.Attribute.Email & Schema.Attribute.Required;
    userId: Schema.Attribute.Integer & Schema.Attribute.Required;
    userName: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

export interface ApiCartCart extends Struct.CollectionTypeSchema {
  collectionName: 'carts';
  info: {
    description: 'User shopping cart';
    displayName: 'Cart';
    pluralName: 'carts';
    singularName: 'cart';
  };
  options: {
    comment: '';
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    formData: Schema.Attribute.JSON & Schema.Attribute.Required;
    items: Schema.Attribute.JSON & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::cart.cart'> &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    sourceProjectId: Schema.Attribute.Integer;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::users-permissions.user'
    >;
  };
}

export interface ApiCategoryCategory extends Struct.CollectionTypeSchema {
  collectionName: 'categories';
  info: {
    description: 'Organize your content into categories';
    displayName: 'Category';
    pluralName: 'categories';
    singularName: 'category';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    articles: Schema.Attribute.Relation<'oneToMany', 'api::article.article'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::category.category'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    slug: Schema.Attribute.UID;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiChatroomChatroom extends Struct.CollectionTypeSchema {
  collectionName: 'chatrooms';
  info: {
    description: 'Chat rooms for order-based conversations between advertisers and publishers';
    displayName: 'Chatroom';
    pluralName: 'chatrooms';
    singularName: 'chatroom';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    advertiser: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    communications: Schema.Attribute.Relation<
      'oneToMany',
      'api::communication.communication'
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    lastActivity: Schema.Attribute.DateTime;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::chatroom.chatroom'
    > &
      Schema.Attribute.Private;
    order: Schema.Attribute.Relation<'oneToOne', 'api::order.order'>;
    publishedAt: Schema.Attribute.DateTime;
    publisher: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    status: Schema.Attribute.Enumeration<['active', 'closed', 'archived']> &
      Schema.Attribute.DefaultTo<'active'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiCommunicationCommunication
  extends Struct.CollectionTypeSchema {
  collectionName: 'communications';
  info: {
    description: 'Communications between publishers and advertisers regarding orders';
    displayName: 'Communication';
    pluralName: 'communications';
    singularName: 'communication';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    chatroom: Schema.Attribute.Relation<'manyToOne', 'api::chatroom.chatroom'>;
    communicationStatus: Schema.Attribute.Enumeration<
      ['requested', 'acceptance', 'in_progress']
    > &
      Schema.Attribute.DefaultTo<'requested'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    isUnread: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::communication.communication'
    > &
      Schema.Attribute.Private;
    message: Schema.Attribute.Text & Schema.Attribute.Required;
    order: Schema.Attribute.Relation<'manyToOne', 'api::order.order'>;
    publishedAt: Schema.Attribute.DateTime;
    sender: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiGlobalConfigGlobalConfig
  extends Struct.CollectionTypeSchema {
  collectionName: 'global_configs';
  info: {
    displayName: 'Global Config';
    pluralName: 'global-configs';
    singularName: 'global-config';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    autoApproveDays: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<5>;
    autoReleaseDays: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<7>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::global-config.global-config'
    > &
      Schema.Attribute.Private;
    minPayoutAmount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<10>;
    paymentGateways: Schema.Attribute.JSON &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<{
        paypal: {
          description: 'PayPal payments';
          displayName: 'PayPal';
          enabled: true;
        };
        phonepe: {
          description: 'PhonePe UPI payments';
          displayName: 'PhonePe';
          enabled: true;
        };
        razorpay: {
          description: 'Razorpay payment gateway';
          displayName: 'Razorpay';
          enabled: true;
        };
        stripe: {
          description: 'Credit card payments via Stripe';
          displayName: 'Stripe';
          enabled: true;
        };
      }>;
    publishedAt: Schema.Attribute.DateTime;
    supportedCurrencies: Schema.Attribute.JSON &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<['USD']>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiGlobalGlobal extends Struct.SingleTypeSchema {
  collectionName: 'globals';
  info: {
    description: 'Define global settings';
    displayName: 'Global';
    pluralName: 'globals';
    singularName: 'global';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    defaultSeo: Schema.Attribute.Component<'shared.seo', false>;
    favicon: Schema.Attribute.Media<'images' | 'files' | 'videos'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::global.global'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    siteDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    siteName: Schema.Attribute.String & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiInvoiceInvoice extends Struct.CollectionTypeSchema {
  collectionName: 'invoices';
  info: {
    description: 'Manages customer invoices for wallet transactions';
    displayName: 'Invoice';
    pluralName: 'invoices';
    singularName: 'invoice';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    billingAddress: Schema.Attribute.Text & Schema.Attribute.Required;
    billingCity: Schema.Attribute.String;
    billingCountry: Schema.Attribute.String;
    billingName: Schema.Attribute.String & Schema.Attribute.Required;
    billingPincode: Schema.Attribute.String;
    billingVatGst: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    currency: Schema.Attribute.String & Schema.Attribute.Required;
    invoice: Schema.Attribute.Relation<'oneToOne', 'api::invoice.invoice'>;
    invoiceDate: Schema.Attribute.Date & Schema.Attribute.Required;
    invoiceNumber: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    lineItems: Schema.Attribute.JSON & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::invoice.invoice'
    > &
      Schema.Attribute.Private;
    notes: Schema.Attribute.Text;
    pdfUrl: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    status: Schema.Attribute.Enumeration<['draft', 'paid', 'void']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'paid'>;
    subtotal: Schema.Attribute.Decimal & Schema.Attribute.Required;
    taxAmount: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<0>;
    totalAmount: Schema.Attribute.Decimal & Schema.Attribute.Required;
    transactionId: Schema.Attribute.String & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
  };
}

export interface ApiMarketplaceListMarketplaceList
  extends Struct.CollectionTypeSchema {
  collectionName: 'marketplace_lists';
  info: {
    description: 'User-created lists of marketplace items';
    displayName: 'Marketplace List';
    pluralName: 'marketplace-lists';
    singularName: 'marketplace-list';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: true;
    };
    'content-type-builder': {
      visible: true;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::marketplace-list.marketplace-list'
    > &
      Schema.Attribute.Private;
    marketplaces: Schema.Attribute.Relation<
      'manyToMany',
      'api::marketplace.marketplace'
    >;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    owner: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiMarketplaceMarketplace extends Struct.CollectionTypeSchema {
  collectionName: 'marketplaces';
  info: {
    description: '';
    displayName: 'Marketplace';
    pluralName: 'marketplaces';
    singularName: 'marketplace';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    adv_casino_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    adv_cbd_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    adv_crypto_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    adv_dating_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    adv_li_casino_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    adv_li_cbd_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    adv_li_crypto_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    adv_li_dating_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    ahrefs_dr: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    ahrefs_rank: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    ahrefs_referring_domain: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    ahrefs_traffic: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    approvalStatus: Schema.Attribute.Enumeration<
      ['pending', 'approved', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'approved'>;
    backlink_type: Schema.Attribute.Enumeration<['Do follow', 'No follow']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'Do follow'>;
    backlink_validity: Schema.Attribute.String & Schema.Attribute.Required;
    blacklist_status: Schema.Attribute.Enumeration<['active', 'inactive']> &
      Schema.Attribute.DefaultTo<'active'>;
    category: Schema.Attribute.JSON & Schema.Attribute.Required;
    countries: Schema.Attribute.JSON;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    dataVersion: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    delistedAt: Schema.Attribute.DateTime;
    delistedReason: Schema.Attribute.Enumeration<
      ['ownership_transferred', 'admin_action', 'violation', 'other']
    >;
    digital_pr: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    dofollow_link: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<1>;
    domain_zone: Schema.Attribute.String;
    fast_placement_status: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    gsc_permission_level: Schema.Attribute.Enumeration<
      ['siteOwner', 'siteFullUser', 'siteUnverifiedUser', 'siteRestrictedUser']
    >;
    gsc_refresh_token: Schema.Attribute.Text & Schema.Attribute.Private;
    gsc_verified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    gsc_verified_at: Schema.Attribute.DateTime;
    guidelines: Schema.Attribute.Text;
    language: Schema.Attribute.JSON & Schema.Attribute.Required;
    link_insertion_price: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::marketplace.marketplace'
    > &
      Schema.Attribute.Private;
    min_word_count: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    moz_da: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    only_with_us: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    orders: Schema.Attribute.Relation<'oneToMany', 'api::order.order'>;
    other_category: Schema.Attribute.JSON;
    placement_speed: Schema.Attribute.Enumeration<
      ['Ultra Fast', 'Fast', 'Normal', 'Slow']
    > &
      Schema.Attribute.DefaultTo<'Normal'>;
    price: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    publisher_casino_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_cbd_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_crypto_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_dating_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_email: Schema.Attribute.Email & Schema.Attribute.Required;
    publisher_forbidden_gp_price: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_forbidden_li_price: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_li_casino_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_li_cbd_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_li_crypto_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_li_dating_pricing: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_link_insertion_price: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_name: Schema.Attribute.String & Schema.Attribute.Required;
    publisher_price: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    publisher_writing_price: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    sample_links: Schema.Attribute.Text;
    sample_post: Schema.Attribute.Text;
    semrush_authority_score: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    semrush_traffic: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    shortlists: Schema.Attribute.Relation<
      'oneToMany',
      'api::shortlist.shortlist'
    >;
    similarweb_traffic: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    spam_score: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    sponsored: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    status: Schema.Attribute.Enumeration<
      ['active', 'paused', 'draft', 'rejected', 'delisted']
    > &
      Schema.Attribute.DefaultTo<'active'>;
    tat: Schema.Attribute.Integer;
    ugc: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    updateRequests: Schema.Attribute.Relation<
      'oneToMany',
      'api::website-update-request.website-update-request'
    >;
    url: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    website_status: Schema.Attribute.Enumeration<
      ['pending', 'active', 'draft', 'rejected']
    > &
      Schema.Attribute.DefaultTo<'pending'>;
  };
}

export interface ApiNotificationNotification
  extends Struct.CollectionTypeSchema {
  collectionName: 'notifications';
  info: {
    description: 'User notifications for various system events';
    displayName: 'Notification';
    pluralName: 'notifications';
    singularName: 'notification';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    action: Schema.Attribute.Enumeration<
      [
        'new_order',
        'order_accepted',
        'order_rejected',
        'order_delivered',
        'order_completed',
        'revision_requested',
        'revision_in_progress',
        'revision_completed',
        'payment_received',
        'withdrawal_approved',
        'withdrawal_denied',
        'withdrawal_paid',
        'message_received',
        'delivery_accepted_by_advertiser',
        'system_update',
      ]
    > &
      Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    data: Schema.Attribute.JSON;
    isRead: Schema.Attribute.Boolean &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<false>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::notification.notification'
    > &
      Schema.Attribute.Private;
    message: Schema.Attribute.Text & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    recipient: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    relatedOrderId: Schema.Attribute.Integer;
    relatedUserId: Schema.Attribute.Integer;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 255;
      }>;
    type: Schema.Attribute.Enumeration<
      ['order', 'payment', 'system', 'communication']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'system'>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiOrderContentOrderContent
  extends Struct.CollectionTypeSchema {
  collectionName: 'order_contents';
  info: {
    description: 'Content details associated with orders';
    displayName: 'OrderContent';
    pluralName: 'order-contents';
    singularName: 'order-content';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    content: Schema.Attribute.RichText & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    keywords: Schema.Attribute.Text;
    links: Schema.Attribute.JSON;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::order-content.order-content'
    > &
      Schema.Attribute.Private;
    metaDescription: Schema.Attribute.Text;
    minWordCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<1000>;
    order: Schema.Attribute.Relation<'oneToOne', 'api::order.order'>;
    publishedAt: Schema.Attribute.DateTime;
    title: Schema.Attribute.String & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    url: Schema.Attribute.String;
  };
}

export interface ApiOrderOrder extends Struct.CollectionTypeSchema {
  collectionName: 'orders';
  info: {
    description: 'Link building orders between advertisers and publishers';
    displayName: 'Order';
    pluralName: 'orders';
    singularName: 'order';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    acceptedDate: Schema.Attribute.DateTime;
    advertiser: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    anchorText: Schema.Attribute.String;
    chatroom: Schema.Attribute.Relation<'oneToOne', 'api::chatroom.chatroom'>;
    communications: Schema.Attribute.Relation<
      'oneToMany',
      'api::communication.communication'
    >;
    completedDate: Schema.Attribute.DateTime;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    deliveredDate: Schema.Attribute.DateTime;
    deliveryProof: Schema.Attribute.String;
    description: Schema.Attribute.Text & Schema.Attribute.Required;
    disputeDate: Schema.Attribute.DateTime;
    escrowHeld: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    existingPostUrl: Schema.Attribute.String;
    isOutsourced: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    landingPageUrl: Schema.Attribute.String;
    linkInsertionDescription: Schema.Attribute.Text;
    linkInsertionLanguage: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<'oneToMany', 'api::order.order'> &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON;
    orderContent: Schema.Attribute.Relation<
      'oneToOne',
      'api::order-content.order-content'
    >;
    orderDate: Schema.Attribute.DateTime & Schema.Attribute.Required;
    orderStatus: Schema.Attribute.Enumeration<
      [
        'pending',
        'accepted',
        'rejected',
        'delivered',
        'approved',
        'completed',
        'cancelled',
        'disputed',
      ]
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'pending'>;
    outsourcedContent: Schema.Attribute.Relation<
      'oneToOne',
      'api::outsourced-content.outsourced-content'
    >;
    project: Schema.Attribute.Relation<'manyToOne', 'api::project.project'>;
    publishedAt: Schema.Attribute.DateTime;
    publisher: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    rejectedDate: Schema.Attribute.DateTime;
    rejectionReason: Schema.Attribute.Text;
    revisionDeadline: Schema.Attribute.DateTime;
    revisionRequestedAt: Schema.Attribute.DateTime;
    revisionStatus: Schema.Attribute.Enumeration<
      ['requested', 'in_progress', 'completed']
    >;
    serviceType: Schema.Attribute.String;
    specialCategory: Schema.Attribute.String;
    totalAmount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0.01;
        },
        number
      >;
    transactions: Schema.Attribute.Relation<
      'oneToMany',
      'api::transaction.transaction'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    website: Schema.Attribute.Relation<
      'manyToOne',
      'api::marketplace.marketplace'
    >;
    websiteAhrefsDr: Schema.Attribute.Integer;
    websiteAhrefsTraffic: Schema.Attribute.Integer;
    websiteBacklinkType: Schema.Attribute.String;
    websiteBacklinkValidity: Schema.Attribute.String;
    websiteCategory: Schema.Attribute.JSON;
    websiteCountries: Schema.Attribute.JSON;
    websiteDofollowLink: Schema.Attribute.Integer;
    websiteFastPlacement: Schema.Attribute.Boolean;
    websiteGuidelines: Schema.Attribute.Text;
    websiteLanguage: Schema.Attribute.JSON;
    websiteLinkInsertionPrice: Schema.Attribute.Integer;
    websiteMinWordCount: Schema.Attribute.Integer;
    websiteMozDa: Schema.Attribute.Integer;
    websitePrice: Schema.Attribute.Integer;
    websitePublisherEmail: Schema.Attribute.String;
    websitePublisherName: Schema.Attribute.String;
    websitePublisherPrice: Schema.Attribute.Integer;
    websiteSnapshot: Schema.Attribute.JSON;
    websiteTat: Schema.Attribute.Integer;
    websiteUrl: Schema.Attribute.String;
  };
}

export interface ApiOutsourcedContentOutsourcedContent
  extends Struct.CollectionTypeSchema {
  collectionName: 'outsourced_contents';
  info: {
    description: 'Details for outsourced content orders';
    displayName: 'Outsourced Content';
    pluralName: 'outsourced-contents';
    singularName: 'outsourced-content';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    instructions: Schema.Attribute.Text;
    links: Schema.Attribute.JSON;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::outsourced-content.outsourced-content'
    > &
      Schema.Attribute.Private;
    order: Schema.Attribute.Relation<'oneToOne', 'api::order.order'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiPaymentGatewaysPaymentGatewaySetting
  extends Struct.SingleTypeSchema {
  collectionName: 'payment_gateway_settings';
  info: {
    description: 'Payment gateway configuration settings';
    displayName: 'Payment Gateway Settings';
    pluralName: 'payment-gateway-settings';
    singularName: 'payment-gateway-setting';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    bankTransferEnabled: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<true>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::payment-gateways.payment-gateway-setting'
    > &
      Schema.Attribute.Private;
    paypalEnabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    paypalFeePercentage: Schema.Attribute.Decimal &
      Schema.Attribute.DefaultTo<3.49>;
    paypalFixedFee: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<0.49>;
    phonepeEnabled: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    phonepeFeePercentage: Schema.Attribute.Decimal &
      Schema.Attribute.DefaultTo<2>;
    phonepeGstPercentage: Schema.Attribute.Decimal &
      Schema.Attribute.DefaultTo<18>;
    publishedAt: Schema.Attribute.DateTime;
    razorpayEnabled: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    razorpayFeePercentage: Schema.Attribute.Decimal &
      Schema.Attribute.DefaultTo<2>;
    razorpayGstPercentage: Schema.Attribute.Decimal &
      Schema.Attribute.DefaultTo<18>;
    stripeEnabled: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    stripeFeePercentage: Schema.Attribute.Decimal &
      Schema.Attribute.DefaultTo<2.9>;
    stripeFixedFee: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<0.3>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    usdToInrRate: Schema.Attribute.Decimal & Schema.Attribute.DefaultTo<83.25>;
  };
}

export interface ApiProjectProject extends Struct.CollectionTypeSchema {
  collectionName: 'projects';
  info: {
    description: 'Organize and manage advertiser orders in projects';
    displayName: 'Project';
    pluralName: 'projects';
    singularName: 'project';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    archived: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    files: Schema.Attribute.Media<
      'images' | 'files' | 'videos' | 'audios',
      true
    >;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::project.project'
    > &
      Schema.Attribute.Private;
    orders: Schema.Attribute.Relation<'oneToMany', 'api::order.order'>;
    owner: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    ProjectName: Schema.Attribute.String & Schema.Attribute.Required;
    projectUrl: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    startDate: Schema.Attribute.DateTime & Schema.Attribute.Required;
    status: Schema.Attribute.Enumeration<
      ['active', 'paused', 'completed', 'archived']
    > &
      Schema.Attribute.DefaultTo<'active'>;
    team: Schema.Attribute.Relation<
      'manyToMany',
      'plugin::users-permissions.user'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiPromoCodePromoCode extends Struct.CollectionTypeSchema {
  collectionName: 'promo_codes';
  info: {
    displayName: 'Promo Code';
    pluralName: 'promo-codes';
    singularName: 'promo-code';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    amount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    currentRedemptions: Schema.Attribute.Integer &
      Schema.Attribute.DefaultTo<0>;
    description: Schema.Attribute.Text;
    expiryDate: Schema.Attribute.DateTime & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::promo-code.promo-code'
    > &
      Schema.Attribute.Private;
    maxRedemptions: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<1>;
    promoStatus: Schema.Attribute.Enumeration<['active', 'inactive']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'active'>;
    publishedAt: Schema.Attribute.DateTime;
    redemptions: Schema.Attribute.Relation<
      'oneToMany',
      'api::promo-redemption.promo-redemption'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiPromoRedemptionPromoRedemption
  extends Struct.CollectionTypeSchema {
  collectionName: 'promo_redemptions';
  info: {
    displayName: 'Promo Redemption';
    pluralName: 'promo-redemptions';
    singularName: 'promo-redemption';
  };
  options: {
    draftAndPublish: true;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::promo-redemption.promo-redemption'
    > &
      Schema.Attribute.Private;
    promoCode: Schema.Attribute.Relation<
      'manyToOne',
      'api::promo-code.promo-code'
    >;
    publishedAt: Schema.Attribute.DateTime;
    redeemedAt: Schema.Attribute.DateTime & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
  };
}

export interface ApiPublisherWebsitePublisherWebsite
  extends Struct.CollectionTypeSchema {
  collectionName: 'publisher_websites';
  info: {
    description: 'Website submissions from publishers for marketplace approval';
    displayName: 'Publisher Website Submission';
    pluralName: 'publisher-websites';
    singularName: 'publisher-website';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    addedByReseller: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    ahrefs_dr: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    ahrefs_keywords: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    ahrefs_rank: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 1;
        },
        number
      >;
    ahrefs_referring_domain: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    ahrefs_traffic: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    allowedLinks: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 3;
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<1>;
    approvedAt: Schema.Attribute.DateTime;
    backlinkType: Schema.Attribute.Enumeration<['Do follow', 'No follow']> &
      Schema.Attribute.DefaultTo<'Do follow'>;
    backlinkValidity: Schema.Attribute.Enumeration<
      ['one_year', 'three_years', 'five_years', 'lifetime']
    > &
      Schema.Attribute.DefaultTo<'one_year'>;
    casinoAccepted: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    casinoGuestPostPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    casinoLinkInsertionPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    category: Schema.Attribute.JSON;
    category_search: Schema.Attribute.Text &
      Schema.Attribute.Private &
      Schema.Attribute.DefaultTo<''>;
    cbdAccepted: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    cbdGuestPostPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    cbdLinkInsertionPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    changeRequests: Schema.Attribute.Text;
    claimedAt: Schema.Attribute.DateTime;
    claimedBy: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    claimedFrom: Schema.Attribute.String;
    claimingInProgress: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    claimSubmittedAt: Schema.Attribute.DateTime;
    copywritingPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    countries: Schema.Attribute.JSON &
      Schema.Attribute.DefaultTo<['United States']>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    cryptoAccepted: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    cryptoGuestPostPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    cryptoLinkInsertionPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    currentPublisherId: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    datingAccepted: Schema.Attribute.Boolean &
      Schema.Attribute.DefaultTo<false>;
    datingGuestPostPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    datingLinkInsertionPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    description: Schema.Attribute.Text;
    detailsCompletedAt: Schema.Attribute.DateTime;
    doCopywriting: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    expectedTATHours: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<168>;
    generalGuestPostPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    generalLinkInsertionPrice: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    gscPermissionLevel: Schema.Attribute.Enumeration<
      ['siteOwner', 'siteFullUser', 'siteUnverifiedUser', 'siteRestrictedUser']
    >;
    gscRefreshToken: Schema.Attribute.Text & Schema.Attribute.Private;
    gscVerified: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    gscVerifiedAt: Schema.Attribute.DateTime;
    guidelines: Schema.Attribute.Text;
    isPRSite: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    language: Schema.Attribute.JSON & Schema.Attribute.DefaultTo<['English']>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::publisher-website.publisher-website'
    > &
      Schema.Attribute.Private;
    marketplaceId: Schema.Attribute.Integer;
    metrics_last_updated: Schema.Attribute.DateTime;
    metrics_update_count: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    metrics_update_method: Schema.Attribute.Enumeration<
      ['manual', 'api', 'bulk_import']
    >;
    minWordCount: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<500>;
    moz_da: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    moz_spam_score: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    newOwnerWebsiteId: Schema.Attribute.Integer;
    originalPublisherId: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    originalWebsiteId: Schema.Attribute.Integer;
    ownershipTransferReason: Schema.Attribute.Enumeration<
      ['claimed_by_owner', 'admin_transfer', 'other']
    >;
    ownershipTransferredAt: Schema.Attribute.DateTime;
    pausedAt: Schema.Attribute.DateTime;
    protocol: Schema.Attribute.Enumeration<['https', 'http']> &
      Schema.Attribute.DefaultTo<'https'>;
    publishedAt: Schema.Attribute.DateTime;
    publisherEmail: Schema.Attribute.Email & Schema.Attribute.Required;
    publisherName: Schema.Attribute.String;
    rejectionReason: Schema.Attribute.Text;
    resellerCode: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50;
      }>;
    resumedAt: Schema.Attribute.DateTime;
    reviewedAt: Schema.Attribute.DateTime;
    reviewedBy: Schema.Attribute.String;
    reviewNotes: Schema.Attribute.Text;
    reviewStartedAt: Schema.Attribute.DateTime;
    samplePosts: Schema.Attribute.JSON;
    semrush_authority_score: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          max: 1000;
          min: 0;
        },
        number
      >;
    semrush_traffic: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    sponsored: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    stepCompleted: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 4;
          min: 1;
        },
        number
      > &
      Schema.Attribute.DefaultTo<1>;
    submissionStatus: Schema.Attribute.Enumeration<
      [
        'pending_verification',
        'pending_final_submission',
        'approval_pending',
        'rejected',
        'approved',
        'listing_paused',
        'ownership_claimed',
        'ownership_transferred',
      ]
    > &
      Schema.Attribute.DefaultTo<'pending_verification'>;
    ugc: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    updateRequests: Schema.Attribute.Relation<
      'oneToMany',
      'api::website-update-request.website-update-request'
    >;
    url: Schema.Attribute.String & Schema.Attribute.Required;
    urlAddedAt: Schema.Attribute.DateTime;
    verificationMethod: Schema.Attribute.Enumeration<
      [
        'google-search-console',
        'google-analytics',
        'html-file',
        'meta-tag',
        'reseller-code',
      ]
    >;
  };
}

export interface ApiResellerCodeResellerCode
  extends Struct.CollectionTypeSchema {
  collectionName: 'reseller_codes';
  info: {
    description: 'Codes for resellers to bypass website verification';
    displayName: 'Reseller Code';
    pluralName: 'reseller-codes';
    singularName: 'reseller-code';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    assignedTo: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    assignedToName: Schema.Attribute.String;
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 50;
      }>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    expiresAt: Schema.Attribute.DateTime;
    isActive: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    lastUsedAt: Schema.Attribute.DateTime;
    lastUsedBy: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::reseller-code.reseller-code'
    > &
      Schema.Attribute.Private;
    notes: Schema.Attribute.Text;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    usageLimit: Schema.Attribute.Integer;
    usedCount: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
  };
}

export interface ApiSavedFilterSavedFilter extends Struct.CollectionTypeSchema {
  collectionName: 'saved_filters';
  info: {
    description: "Store user's saved marketplace filters";
    displayName: 'Saved Filter';
    pluralName: 'saved-filters';
    singularName: 'saved-filter';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    filterConfig: Schema.Attribute.JSON & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::saved-filter.saved-filter'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
  };
}

export interface ApiShortlistShortlist extends Struct.CollectionTypeSchema {
  collectionName: 'shortlists';
  info: {
    description: 'User-shortlisted marketplace items for projects';
    displayName: 'Shortlist';
    pluralName: 'shortlists';
    singularName: 'shortlist';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: true;
    };
    'content-type-builder': {
      visible: true;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::shortlist.shortlist'
    > &
      Schema.Attribute.Private;
    marketplace: Schema.Attribute.Relation<
      'manyToOne',
      'api::marketplace.marketplace'
    >;
    owner: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiTransactionTransaction extends Struct.CollectionTypeSchema {
  collectionName: 'transactions';
  info: {
    description: 'Wallet transactions for deposits, withdrawals, and escrow';
    displayName: 'Transaction';
    pluralName: 'transactions';
    singularName: 'transaction';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    amount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    denial_reason: Schema.Attribute.Text;
    description: Schema.Attribute.Text;
    external_transaction_id: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 255;
      }>;
    fee: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    fund_source: Schema.Attribute.Enumeration<['main_fund', 'promo_fund']>;
    gateway: Schema.Attribute.Enumeration<
      ['stripe', 'paypal', 'razorpay', 'promo', 'voucher', 'system']
    > &
      Schema.Attribute.Required;
    gatewayTransactionId: Schema.Attribute.String & Schema.Attribute.Required;
    invoice: Schema.Attribute.Relation<'oneToOne', 'api::invoice.invoice'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::transaction.transaction'
    > &
      Schema.Attribute.Private;
    metadata: Schema.Attribute.JSON;
    netAmount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    order: Schema.Attribute.Relation<'manyToOne', 'api::order.order'>;
    payment_notes: Schema.Attribute.Text;
    promo_code_id: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    transactionStatus: Schema.Attribute.Enumeration<
      [
        'pending',
        'success',
        'failed',
        'cancelled',
        'approved',
        'refunded',
        'denied',
        'paid',
      ]
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'pending'>;
    type: Schema.Attribute.Enumeration<
      [
        'deposit',
        'promo',
        'escrow_hold',
        'escrow_release',
        'payment',
        'withdrawal',
        'fee',
        'refund',
        'payout',
      ]
    > &
      Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user_wallet: Schema.Attribute.Relation<
      'manyToOne',
      'api::user-wallet.user-wallet'
    >;
    users_permissions_user: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
  };
}

export interface ApiUserWalletUserWallet extends Struct.CollectionTypeSchema {
  collectionName: 'user_wallets';
  info: {
    description: 'Wallet system for advertisers and publishers';
    displayName: 'User-Wallet';
    pluralName: 'user-wallets';
    singularName: 'user-wallet';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: true;
    };
    'content-type-builder': {
      visible: true;
    };
  };
  attributes: {
    balance: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    currency: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'USD'>;
    escrowBalance: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::user-wallet.user-wallet'
    > &
      Schema.Attribute.Private;
    mainBalance: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    pendingWithdrawalBalance: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    promoBalance: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      > &
      Schema.Attribute.DefaultTo<0>;
    publishedAt: Schema.Attribute.DateTime;
    transactions: Schema.Attribute.Relation<
      'oneToMany',
      'api::transaction.transaction'
    >;
    type: Schema.Attribute.Enumeration<['advertiser', 'publisher', 'unified']> &
      Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users_permissions_user: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::users-permissions.user'
    >;
  };
}

export interface ApiVoucherCodeVoucherCode extends Struct.CollectionTypeSchema {
  collectionName: 'voucher_codes';
  info: {
    description: '';
    displayName: 'Voucher Code';
    pluralName: 'voucher-codes';
    singularName: 'voucher-code';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    amount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    code: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.Text;
    expiryDate: Schema.Attribute.DateTime & Schema.Attribute.Required;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::voucher-code.voucher-code'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    usedAt: Schema.Attribute.DateTime;
    usedBy: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::users-permissions.user'
    >;
    voucherStatus: Schema.Attribute.Enumeration<
      ['active', 'used', 'expired', 'inactive']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'active'>;
  };
}

export interface ApiWebsiteRequestWebsiteRequest
  extends Struct.CollectionTypeSchema {
  collectionName: 'website_requests';
  info: {
    description: 'Requests for specific websites or website criteria from advertisers';
    displayName: 'Website Request';
    pluralName: 'website-requests';
    singularName: 'website-request';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    additionalRequirements: Schema.Attribute.Text;
    adminNotes: Schema.Attribute.Text;
    approvedAt: Schema.Attribute.DateTime;
    approvedBy: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    assignedTo: Schema.Attribute.String;
    budgetRange: Schema.Attribute.Enumeration<
      [
        'budget50-100',
        'budget100-250',
        'budget250-500',
        'budget500-1000',
        'budget1000+',
        'negotiable',
      ]
    >;
    category: Schema.Attribute.String;
    contactPreference: Schema.Attribute.Enumeration<
      ['email', 'phone', 'chat']
    > &
      Schema.Attribute.DefaultTo<'email'>;
    contentType: Schema.Attribute.Enumeration<
      [
        'guest-post',
        'sponsored-content',
        'product-review',
        'link-insertion',
        'other',
      ]
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    currentFilters: Schema.Attribute.JSON;
    estimatedCost: Schema.Attribute.Decimal &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::website-request.website-request'
    > &
      Schema.Attribute.Private;
    maxDA: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    maxDR: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    maxTraffic: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    minDA: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    minDR: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          max: 100;
          min: 0;
        },
        number
      >;
    minTraffic: Schema.Attribute.Integer &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    proposalSent: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    proposalSentAt: Schema.Attribute.DateTime;
    publishedAt: Schema.Attribute.DateTime;
    rejectedAt: Schema.Attribute.DateTime;
    rejectedBy: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    rejectionReason: Schema.Attribute.Text;
    requestType: Schema.Attribute.Enumeration<['specific', 'criteria']> &
      Schema.Attribute.Required;
    responseNotes: Schema.Attribute.Text;
    specificDomains: Schema.Attribute.Text;
    status: Schema.Attribute.Enumeration<
      [
        'pending',
        'under_review',
        'approved',
        'rejected',
        'in-progress',
        'completed',
        'cancelled',
      ]
    > &
      Schema.Attribute.DefaultTo<'pending'>;
    timeline: Schema.Attribute.Enumeration<
      ['asap', 'within1week', 'within2weeks', 'within1month', 'flexible']
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    userEmail: Schema.Attribute.Email & Schema.Attribute.Required;
  };
}

export interface ApiWebsiteUpdateRequestWebsiteUpdateRequest
  extends Struct.CollectionTypeSchema {
  collectionName: 'website_update_requests';
  info: {
    description: 'Pending changes submitted for a marketplace website';
    displayName: 'Website Update Request';
    pluralName: 'website-update-requests';
    singularName: 'website-update-request';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    baseSnapshot: Schema.Attribute.JSON;
    changes: Schema.Attribute.JSON & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    dataVersion: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<0>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::website-update-request.website-update-request'
    > &
      Schema.Attribute.Private;
    marketplace: Schema.Attribute.Relation<
      'manyToOne',
      'api::marketplace.marketplace'
    >;
    notes: Schema.Attribute.Text;
    publishedAt: Schema.Attribute.DateTime;
    publisherWebsite: Schema.Attribute.Relation<
      'manyToOne',
      'api::publisher-website.publisher-website'
    >;
    reviewedAt: Schema.Attribute.DateTime;
    reviewedBy: Schema.Attribute.String;
    source: Schema.Attribute.Enumeration<['publisher', 'admin']> &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'publisher'>;
    status: Schema.Attribute.Enumeration<
      ['pending', 'approved', 'rejected', 'superseded']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'pending'>;
    submittedAt: Schema.Attribute.DateTime;
    submittedBy: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface ApiWithdrawalRequestWithdrawalRequest
  extends Struct.CollectionTypeSchema {
  collectionName: 'withdrawal_requests';
  info: {
    description: 'Withdrawal requests with external transaction tracking';
    displayName: 'Withdrawal Request';
    pluralName: 'withdrawal-requests';
    singularName: 'withdrawal-request';
  };
  options: {
    draftAndPublish: false;
  };
  attributes: {
    admin_notes: Schema.Attribute.Text;
    amount: Schema.Attribute.Decimal &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMax<
        {
          min: 0;
        },
        number
      >;
    approved_at: Schema.Attribute.DateTime;
    approved_by: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    denial_reason: Schema.Attribute.Text;
    details: Schema.Attribute.JSON & Schema.Attribute.Required;
    external_transaction_id: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 255;
      }>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'api::withdrawal-request.withdrawal-request'
    > &
      Schema.Attribute.Private;
    method: Schema.Attribute.Enumeration<
      ['razorpay', 'paypal', 'bank_transfer', 'payoneer']
    > &
      Schema.Attribute.Required;
    paid_at: Schema.Attribute.DateTime;
    paid_by: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    payment_method_used: Schema.Attribute.Enumeration<
      ['paypal', 'bank_transfer', 'razorpay', 'payoneer', 'other']
    >;
    payment_notes: Schema.Attribute.Text;
    payment_reference: Schema.Attribute.String &
      Schema.Attribute.SetMinMaxLength<{
        maxLength: 255;
      }>;
    publishedAt: Schema.Attribute.DateTime;
    publisher: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    rejected_at: Schema.Attribute.DateTime;
    rejected_by: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.user'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    withdrawal_status: Schema.Attribute.Enumeration<
      ['pending', 'approved', 'denied', 'paid']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'pending'>;
  };
}

export interface PluginContentReleasesRelease
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_releases';
  info: {
    displayName: 'Release';
    pluralName: 'releases';
    singularName: 'release';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    actions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    >;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    publishedAt: Schema.Attribute.DateTime;
    releasedAt: Schema.Attribute.DateTime;
    scheduledAt: Schema.Attribute.DateTime;
    status: Schema.Attribute.Enumeration<
      ['ready', 'blocked', 'failed', 'done', 'empty']
    > &
      Schema.Attribute.Required;
    timezone: Schema.Attribute.String;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginContentReleasesReleaseAction
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_release_actions';
  info: {
    displayName: 'Release Action';
    pluralName: 'release-actions';
    singularName: 'release-action';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentType: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    entryDocumentId: Schema.Attribute.String;
    isEntryValid: Schema.Attribute.Boolean;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::content-releases.release-action'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    release: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::content-releases.release'
    >;
    type: Schema.Attribute.Enumeration<['publish', 'unpublish']> &
      Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginI18NLocale extends Struct.CollectionTypeSchema {
  collectionName: 'i18n_locale';
  info: {
    collectionName: 'locales';
    description: '';
    displayName: 'Locale';
    pluralName: 'locales';
    singularName: 'locale';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    code: Schema.Attribute.String & Schema.Attribute.Unique;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::i18n.locale'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.SetMinMax<
        {
          max: 50;
          min: 1;
        },
        number
      >;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflow
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows';
  info: {
    description: '';
    displayName: 'Workflow';
    name: 'Workflow';
    pluralName: 'workflows';
    singularName: 'workflow';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    contentTypes: Schema.Attribute.JSON &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'[]'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    stageRequiredToPublish: Schema.Attribute.Relation<
      'oneToOne',
      'plugin::review-workflows.workflow-stage'
    >;
    stages: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginReviewWorkflowsWorkflowStage
  extends Struct.CollectionTypeSchema {
  collectionName: 'strapi_workflows_stages';
  info: {
    description: '';
    displayName: 'Stages';
    name: 'Workflow Stage';
    pluralName: 'workflow-stages';
    singularName: 'workflow-stage';
  };
  options: {
    draftAndPublish: false;
    version: '1.1.0';
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    color: Schema.Attribute.String & Schema.Attribute.DefaultTo<'#4945FF'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::review-workflows.workflow-stage'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String;
    permissions: Schema.Attribute.Relation<'manyToMany', 'admin::permission'>;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    workflow: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::review-workflows.workflow'
    >;
  };
}

export interface PluginUploadFile extends Struct.CollectionTypeSchema {
  collectionName: 'files';
  info: {
    description: '';
    displayName: 'File';
    pluralName: 'files';
    singularName: 'file';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    alternativeText: Schema.Attribute.String;
    caption: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    ext: Schema.Attribute.String;
    folder: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'> &
      Schema.Attribute.Private;
    folderPath: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    formats: Schema.Attribute.JSON;
    hash: Schema.Attribute.String & Schema.Attribute.Required;
    height: Schema.Attribute.Integer;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.file'
    > &
      Schema.Attribute.Private;
    mime: Schema.Attribute.String & Schema.Attribute.Required;
    name: Schema.Attribute.String & Schema.Attribute.Required;
    previewUrl: Schema.Attribute.String;
    provider: Schema.Attribute.String & Schema.Attribute.Required;
    provider_metadata: Schema.Attribute.JSON;
    publishedAt: Schema.Attribute.DateTime;
    related: Schema.Attribute.Relation<'morphToMany'>;
    size: Schema.Attribute.Decimal & Schema.Attribute.Required;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    url: Schema.Attribute.String & Schema.Attribute.Required;
    width: Schema.Attribute.Integer;
  };
}

export interface PluginUploadFolder extends Struct.CollectionTypeSchema {
  collectionName: 'upload_folders';
  info: {
    displayName: 'Folder';
    pluralName: 'folders';
    singularName: 'folder';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    children: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.folder'>;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    files: Schema.Attribute.Relation<'oneToMany', 'plugin::upload.file'>;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::upload.folder'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    parent: Schema.Attribute.Relation<'manyToOne', 'plugin::upload.folder'>;
    path: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 1;
      }>;
    pathId: Schema.Attribute.Integer &
      Schema.Attribute.Required &
      Schema.Attribute.Unique;
    publishedAt: Schema.Attribute.DateTime;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsPermission
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_permissions';
  info: {
    description: '';
    displayName: 'Permission';
    name: 'permission';
    pluralName: 'permissions';
    singularName: 'permission';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    action: Schema.Attribute.String & Schema.Attribute.Required;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    > &
      Schema.Attribute.Private;
    publishedAt: Schema.Attribute.DateTime;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
  };
}

export interface PluginUsersPermissionsRole
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_roles';
  info: {
    description: '';
    displayName: 'Role';
    name: 'role';
    pluralName: 'roles';
    singularName: 'role';
  };
  options: {
    draftAndPublish: false;
  };
  pluginOptions: {
    'content-manager': {
      visible: false;
    };
    'content-type-builder': {
      visible: false;
    };
  };
  attributes: {
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    description: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.role'
    > &
      Schema.Attribute.Private;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
    permissions: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.permission'
    >;
    publishedAt: Schema.Attribute.DateTime;
    type: Schema.Attribute.String & Schema.Attribute.Unique;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    users: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    >;
  };
}

export interface PluginUsersPermissionsUser
  extends Struct.CollectionTypeSchema {
  collectionName: 'up_users';
  info: {
    description: '';
    displayName: 'User';
    name: 'user';
    pluralName: 'users';
    singularName: 'user';
  };
  options: {
    draftAndPublish: false;
    timestamps: true;
  };
  attributes: {
    Advertiser: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    advertiserOrders: Schema.Attribute.Relation<
      'oneToMany',
      'api::order.order'
    >;
    billingAddress: Schema.Attribute.String;
    blocked: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    businessName: Schema.Attribute.String;
    city: Schema.Attribute.String;
    communications: Schema.Attribute.Relation<
      'oneToMany',
      'api::communication.communication'
    >;
    confirmationToken: Schema.Attribute.String & Schema.Attribute.Private;
    confirmed: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    country: Schema.Attribute.String;
    createdAt: Schema.Attribute.DateTime;
    createdBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    email: Schema.Attribute.Email &
      Schema.Attribute.Required &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 6;
      }>;
    firstName: Schema.Attribute.String;
    identity: Schema.Attribute.Enumeration<['SEO', 'Agency', 'Other']>;
    invoices: Schema.Attribute.Relation<'oneToMany', 'api::invoice.invoice'>;
    lastName: Schema.Attribute.String;
    locale: Schema.Attribute.String & Schema.Attribute.Private;
    localizations: Schema.Attribute.Relation<
      'oneToMany',
      'plugin::users-permissions.user'
    > &
      Schema.Attribute.Private;
    notificationPreferences: Schema.Attribute.JSON &
      Schema.Attribute.Configurable &
      Schema.Attribute.DefaultTo<{
        notifyMarketplaceNewItemApp: true;
        notifyMarketplaceNewItemEmail: true;
        notifyOrderMessagesApp: true;
        notifyOrderMessagesEmail: true;
        notifyOrderStatusChangeApp: true;
        notifyOrderStatusChangeEmail: true;
        notifyPlatformNewsApp: true;
        notifyPlatformNewsEmail: false;
        notifyPromotionsApp: false;
        notifyPromotionsEmail: false;
        notifySecurityAlertsApp: true;
        notifySecurityAlertsEmail: true;
        notifyWalletBillingUpdatesApp: true;
        notifyWalletBillingUpdatesEmail: true;
      }>;
    password: Schema.Attribute.Password &
      Schema.Attribute.Private &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 8;
      }>;
    phoneNumber: Schema.Attribute.String;
    pincode: Schema.Attribute.String;
    projects: Schema.Attribute.Relation<'oneToMany', 'api::project.project'>;
    provider: Schema.Attribute.String;
    publishedAt: Schema.Attribute.DateTime;
    Publisher: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    publisherOrders: Schema.Attribute.Relation<'oneToMany', 'api::order.order'>;
    registrationNumber: Schema.Attribute.String;
    resetPasswordToken: Schema.Attribute.String & Schema.Attribute.Private;
    role: Schema.Attribute.Relation<
      'manyToOne',
      'plugin::users-permissions.role'
    >;
    saved_filters: Schema.Attribute.Relation<
      'oneToMany',
      'api::saved-filter.saved-filter'
    >;
    transactions: Schema.Attribute.Relation<
      'oneToMany',
      'api::transaction.transaction'
    >;
    updatedAt: Schema.Attribute.DateTime;
    updatedBy: Schema.Attribute.Relation<'oneToOne', 'admin::user'> &
      Schema.Attribute.Private;
    user_wallet: Schema.Attribute.Relation<
      'oneToOne',
      'api::user-wallet.user-wallet'
    >;
    username: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.Unique &
      Schema.Attribute.SetMinMaxLength<{
        minLength: 3;
      }>;
    vatGstNumber: Schema.Attribute.String;
    website: Schema.Attribute.String;
    withdrawalRequests: Schema.Attribute.Relation<
      'oneToMany',
      'api::withdrawal-request.withdrawal-request'
    >;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ContentTypeSchemas {
      'admin::api-token': AdminApiToken;
      'admin::api-token-permission': AdminApiTokenPermission;
      'admin::permission': AdminPermission;
      'admin::role': AdminRole;
      'admin::transfer-token': AdminTransferToken;
      'admin::transfer-token-permission': AdminTransferTokenPermission;
      'admin::user': AdminUser;
      'api::about.about': ApiAboutAbout;
      'api::admin-audit-log.admin-audit-log': ApiAdminAuditLogAdminAuditLog;
      'api::article.article': ApiArticleArticle;
      'api::auth.auth': ApiAuthAuth;
      'api::author.author': ApiAuthorAuthor;
      'api::bank-transfer-request.bank-transfer-request': ApiBankTransferRequestBankTransferRequest;
      'api::cart.cart': ApiCartCart;
      'api::category.category': ApiCategoryCategory;
      'api::chatroom.chatroom': ApiChatroomChatroom;
      'api::communication.communication': ApiCommunicationCommunication;
      'api::global-config.global-config': ApiGlobalConfigGlobalConfig;
      'api::global.global': ApiGlobalGlobal;
      'api::invoice.invoice': ApiInvoiceInvoice;
      'api::marketplace-list.marketplace-list': ApiMarketplaceListMarketplaceList;
      'api::marketplace.marketplace': ApiMarketplaceMarketplace;
      'api::notification.notification': ApiNotificationNotification;
      'api::order-content.order-content': ApiOrderContentOrderContent;
      'api::order.order': ApiOrderOrder;
      'api::outsourced-content.outsourced-content': ApiOutsourcedContentOutsourcedContent;
      'api::payment-gateways.payment-gateway-setting': ApiPaymentGatewaysPaymentGatewaySetting;
      'api::project.project': ApiProjectProject;
      'api::promo-code.promo-code': ApiPromoCodePromoCode;
      'api::promo-redemption.promo-redemption': ApiPromoRedemptionPromoRedemption;
      'api::publisher-website.publisher-website': ApiPublisherWebsitePublisherWebsite;
      'api::reseller-code.reseller-code': ApiResellerCodeResellerCode;
      'api::saved-filter.saved-filter': ApiSavedFilterSavedFilter;
      'api::shortlist.shortlist': ApiShortlistShortlist;
      'api::transaction.transaction': ApiTransactionTransaction;
      'api::user-wallet.user-wallet': ApiUserWalletUserWallet;
      'api::voucher-code.voucher-code': ApiVoucherCodeVoucherCode;
      'api::website-request.website-request': ApiWebsiteRequestWebsiteRequest;
      'api::website-update-request.website-update-request': ApiWebsiteUpdateRequestWebsiteUpdateRequest;
      'api::withdrawal-request.withdrawal-request': ApiWithdrawalRequestWithdrawalRequest;
      'plugin::content-releases.release': PluginContentReleasesRelease;
      'plugin::content-releases.release-action': PluginContentReleasesReleaseAction;
      'plugin::i18n.locale': PluginI18NLocale;
      'plugin::review-workflows.workflow': PluginReviewWorkflowsWorkflow;
      'plugin::review-workflows.workflow-stage': PluginReviewWorkflowsWorkflowStage;
      'plugin::upload.file': PluginUploadFile;
      'plugin::upload.folder': PluginUploadFolder;
      'plugin::users-permissions.permission': PluginUsersPermissionsPermission;
      'plugin::users-permissions.role': PluginUsersPermissionsRole;
      'plugin::users-permissions.user': PluginUsersPermissionsUser;
    }
  }
}
