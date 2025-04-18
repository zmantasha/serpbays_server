import type { Schema, Struct } from '@strapi/strapi';

export interface SharedCountryItem extends Struct.ComponentSchema {
  collectionName: 'components_shared_country_items';
  info: {
    displayName: 'country_item';
  };
  attributes: {
    country: Schema.Attribute.Enumeration<
      [
        'Antigua and Barbuda',
        'Bahamas',
        'Barbados',
        'Belize',
        'Canada',
        'Costa Rica',
        'Cuba',
        'Dominica',
        'Dominican Republic',
        'El Salvador',
        'Grenada',
        'Guatemala',
        'Haiti',
        'Honduras',
        'Jamaica',
        'Mexico',
        'Nicaragua',
        'Panama',
        'Saint Kitts and Nevis',
        'Saint Lucia',
        'Saint Vincent and the Grenadines',
        'Trinidad and Tobago',
        'United States of America',
        'Argentina',
        'Bolivia',
        'Brazil',
        'Chile',
        'Colombia',
        'Ecuador',
        'Guyana',
        'Paraguay',
        'Peru',
        'Suriname',
        'Uruguay',
        'Venezuela',
        'Albania',
        'Andorra',
        'Armenia',
        'Austria',
        'Azerbaijan',
        'Belarus',
        'Belgium',
        'Bosnia and Herzegovina',
        'Bulgaria',
        'Croatia',
        'Cyprus',
        'Czech Republic (Czechia)',
        'Denmark',
        'Estonia',
        'Finland',
        'France',
        'Georgia',
        'Germany',
        'Greece',
        'Hungary',
        'Iceland',
        'Ireland',
        'Italy',
        'Kazakhstan',
        'Kosovo',
        'Latvia',
        'Liechtenstein',
        'Lithuania',
        'Luxembourg',
        'Malta',
        'Moldova',
        'Monaco',
        'Montenegro',
        'Netherlands',
        'North Macedonia',
        'Norway',
        'Poland',
        'Portugal',
        'Romania',
        'Russia',
        'San Marino',
        'Serbia',
        'Slovakia',
        'Slovenia',
        'Spain',
        'Sweden',
        'Switzerland',
        'Ukraine',
        'United Kingdom',
        'Vatican City (Holy See)Algeria',
        'Angola',
        'Benin',
        'Botswana',
        'Burkina Faso',
        'Burundi',
        'Cabo Verde',
        'Cameroon',
        'Central African Republic',
        'Chad',
        'Comoros',
        'Congo (Brazzaville)',
        'Congo (Kinshasa)',
        'Djibouti',
        'Egypt',
        'Equatorial Guinea',
        'Eritrea',
        'Eswatini',
        'Ethiopia',
        'Gabon',
        'Gambia',
        'Ghana',
        'Guinea',
        'Guinea-Bissau',
        "Ivory Coast (C\u00F4te d'Ivoire)",
        'Kenya',
        'Lesotho',
        'Liberia',
        'Libya',
        'Madagascar',
        'Malawi',
        'Mali',
        'Mauritania',
        'Mauritius',
        'Morocco',
        'Mozambique',
        'Namibia',
        'Niger',
        'Nigeria',
        'Rwanda',
        'S\u00E3o Tom\u00E9 and Pr\u00EDncipe',
        'Senegal',
        'Seychelles',
        'Sierra Leone',
        'Somalia',
        'South Africa',
        'South Sudan',
        'Sudan',
        'Tanzania',
        'Togo',
        'Tunisia',
        'Uganda',
        'Zambia',
        'Zimbabwe',
        'Afghanistan',
        'Bahrain',
        'Bangladesh',
        'Bhutan',
        'Brunei',
        'Cambodia',
        'China',
        'India',
        'Indonesia',
        'Iran',
        'Iraq',
        'Israel',
        'Japan',
        'Jordan',
        'Kuwait',
        'Kyrgyzstan',
        'Laos',
        'Lebanon',
        'Malaysia',
        'Maldives',
        'Mongolia',
        'Myanmar (Burma)',
        'Nepal',
        'North Korea',
        'Oma',
        'Pakistan',
        'Palestine',
        'Philippine',
        'Qatar',
        'Saudi Arabi',
        'Singapore',
        'South Korea',
        'Sri Lanka',
        'Syria',
        'Taiwan',
        'Tajikistan',
        'Thailand',
        'Timor-Leste',
        'Turkmenistan',
        'United Arab Emirates',
        'Uzbekistan',
        'Vietnam',
        'Yemen',
        'Australia',
        'Fiji',
        'Kiribati',
        'Marshall Islands',
        'Micronesia',
        'Nauru',
        'New Zealand',
        'Palau',
        'Papua New Guinea',
        'Samoa',
        'Solomon Islands',
        'Tonga',
        'Tuvalu',
        'Vanuatu',
      ]
    >;
  };
}

export interface SharedQuote extends Struct.ComponentSchema {
  collectionName: 'components_shared_quotes';
  info: {
    displayName: 'Quote';
    icon: 'indent';
  };
  attributes: {
    body: Schema.Attribute.Text;
    title: Schema.Attribute.String;
  };
}

export interface SharedRichText extends Struct.ComponentSchema {
  collectionName: 'components_shared_rich_texts';
  info: {
    description: '';
    displayName: 'Rich text';
    icon: 'align-justify';
  };
  attributes: {
    body: Schema.Attribute.RichText;
  };
}

export interface SharedSeo extends Struct.ComponentSchema {
  collectionName: 'components_shared_seos';
  info: {
    description: '';
    displayName: 'Seo';
    icon: 'allergies';
    name: 'Seo';
  };
  attributes: {
    metaDescription: Schema.Attribute.Text & Schema.Attribute.Required;
    metaTitle: Schema.Attribute.String & Schema.Attribute.Required;
    shareImage: Schema.Attribute.Media<'images'>;
  };
}

export interface SharedSlider extends Struct.ComponentSchema {
  collectionName: 'components_shared_sliders';
  info: {
    description: '';
    displayName: 'Slider';
    icon: 'address-book';
  };
  attributes: {
    files: Schema.Attribute.Media<'images', true>;
  };
}

export interface SharedWebUrl extends Struct.ComponentSchema {
  collectionName: 'components_shared_web_urls';
  info: {
    displayName: 'web_URL';
  };
  attributes: {
    Websites: Schema.Attribute.String;
  };
}

export interface SharedWebsiteData extends Struct.ComponentSchema {
  collectionName: 'components_shared_website_data';
  info: {
    displayName: 'Website Data';
  };
  attributes: {
    Price: Schema.Attribute.Integer;
    URL: Schema.Attribute.String;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'shared.country-item': SharedCountryItem;
      'shared.quote': SharedQuote;
      'shared.rich-text': SharedRichText;
      'shared.seo': SharedSeo;
      'shared.slider': SharedSlider;
      'shared.web-url': SharedWebUrl;
      'shared.website-data': SharedWebsiteData;
    }
  }
}
