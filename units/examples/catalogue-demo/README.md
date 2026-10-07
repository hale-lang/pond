# Catalogue with application-chosen quantities

From the Pond root:

```sh
hale build units/examples/catalogue-demo/
./units/examples/catalogue-demo/catalogue-demo
```

Expected output:

```text
5 international feet = 1524mm
250 mL = 250000 uL
15 mmol/L = 15000umol_per_L
1 US liquid gallon, nearest microlitre = 3785412 uL
```

The last conversion deliberately rounds: one US liquid gallon is exactly
3.785411784 L, which is not an integral number of microlitres. The code names
`half_even` at that boundary. It prints the count explicitly because Hale can
render an equivalent unit alias, such as `mm3` for `uL`.
