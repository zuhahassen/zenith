"""Hand-picked Messier/NGC seed catalog. Values from SIMBAD / Messier tables.

Using for current development and testing will replace with a live query when
ready.
"""

from .models import Target


def _m(name, common, ra, dec, mag, maj, min_, kind):
    return Target(
        name=name, common_name=common,
        ra_deg=ra, dec_deg=dec, magnitude=mag,
        size_arcmin=(maj, min_) if maj else None,
        kind=kind,
    )


CATALOG: list[Target] = [
    _m("M31",   "Andromeda Galaxy",      10.6847,  41.2687, 3.4, 95.0, 30.0, "Galaxy"),
    _m("M13",   "Hercules Cluster",     250.4235, 36.4613, 5.8, 10.0, 10.0, "GlCl"),
    _m("M42",   "Orion Nebula",          83.8221, -5.3911, 4.0, 33.0, 30.0, "Nebula"),
    _m("M45",   "Pleiades",              56.7500, 24.1167, 1.6, 55.0, 55.0, "OpenCl"),
    _m("M57",   "Ring Nebula",          283.3962, 33.0292, 8.8,  1.4,  1.0, "Nebula"),
    _m("M51",   "Whirlpool Galaxy",     202.4696, 47.1953, 8.4, 11.2,  6.9, "Galaxy"),
    _m("M81",   "Bode's Galaxy",        148.8882, 69.0653, 6.9, 26.9, 14.1, "Galaxy"),
    _m("M27",   "Dumbbell Nebula",      299.9015, 22.7211, 7.5,  8.0,  5.7, "Nebula"),
    _m("M22",   "Sagittarius Cluster",  279.0997,-23.9047, 5.1, 24.0, 24.0, "GlCl"),
    _m("M8",    "Lagoon Nebula",        270.9042,-24.3867, 6.0, 45.0, 30.0, "Nebula"),
    _m("M101",  "Pinwheel Galaxy",      210.8024, 54.3489, 7.9, 28.8, 26.9, "Galaxy"),
    _m("M104",  "Sombrero Galaxy",      189.9976,-11.6231, 8.0,  8.7,  3.5, "Galaxy"),
    _m("NGC869","Double Cluster",        34.7417, 57.1333, 3.7, 30.0, 30.0, "OpenCl"),
]
