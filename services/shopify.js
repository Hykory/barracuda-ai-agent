async function searchShopifyProducts(query) {
  const response = await fetch(
    `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({
        query: `
          query SearchProducts($query: String!) {
            products(first: 5, query: $query) {
              edges {
                node {
                  title
                  totalInventory
                  variants(first: 3) {
                    edges {
                      node {
                        price
                        inventoryQuantity
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { query },
      }),
    }
  );

  return await response.json();
}

async function searchShopifyOrders(query) {
  const response = await fetch(
    `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({
        query: `
          query SearchOrders($query: String!) {
            orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  name
                  displayFulfillmentStatus
                  displayFinancialStatus
                  createdAt
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  fulfillments(first: 5) {
                    trackingInfo {
                      company
                      number
                      url
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { query: `name:${query}` },
      }),
    }
  );

  return await response.json();
}

module.exports = {
  searchShopifyProducts,
  searchShopifyOrders,
};