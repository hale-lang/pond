# Optional quantities and temperature points

From the Pond root:

```sh
hale build units/examples/quantities-demo/
./units/examples/quantities-demo/quantities-demo
```

Expected output:

```text
one inch = 25400um
battery charge = 9000C
25 C above freezing = 45degF
25 C above absolute zero = 298150mK
```

`q::Length` and `q::Charge` are imported types. Local point refinements preserve
the optional temperature types' origins while enabling native constructors on
the verified compiler. The difference between points is a temperature interval;
the example prints that interval in a chosen unit.
