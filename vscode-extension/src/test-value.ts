export const testValue = <Value>(value?: unknown, _type?: Value): Value => {
  void _type;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- explicit test-double boundary
  return value as Value;
};
