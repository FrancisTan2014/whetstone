export type ProductIdentity = Readonly<{
  focus: "foundation";
  name: "whetstone";
}>;

export const productIdentity: ProductIdentity = Object.freeze({
  focus: "foundation",
  name: "whetstone"
});

export function formatProductHeading(identity: ProductIdentity): string {
  return `${identity.name} ${identity.focus}`;
}
