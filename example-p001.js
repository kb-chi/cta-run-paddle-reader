// example-p001.js — run P001 (Saturday) from the sample paddle, built with the helpers in run.js.
// Handy for testing. Safe to delete.

import { run, half, trip, point, parseRelief } from "./run.js";

// ---------- Example: run P001, Saturday (sample paddle, effective 08/29/2026) ----------

export const exampleP001 = run(
  "P001",
  "Saturday",
  { total: "8h12", allowance: "0h25", spread: "0h00", firstHalf: "2h51", secondHalf: "4h56" },
  [
    half(
      point("06:01", "N PARK GARAGE"),
      [
        trip({ inService: false }, [["N PARK GARAGE", "06:16+"], ["FOSTER ALBANY", "06:16+"]]),
        trip({ headway: "/", route: "93" }, [
          ["FOSTER ALBANY", "06:16+"], ["LAWRNC KEDZIE", "06:19+"], ["IRVING CALIF", "06:25"],
          ["BELMONT CALIF", "06:27"], ["LOGAN SQ L", "06:32"],
        ]),
        trip({ route: "93", follower: "310", headway: "fst/" }, [
          ["LOGAN SQ L", "06:35"], ["BELMONT CALIF", "06:40"], ["IRVING CALIF", "06:42"],
          ["LAWRNC KEDZIE", "06:47+"], ["FOSTER ALBANY", "06:51+"], ["LINCOLN CALIF", "06:56+"],
          ["DEVON CALIFNA", "07:01"], ["TOUHY CALIFNA", "07:05+"], ["HOWARD CALIF", "07:07"],
          ["EMERSON DODGE", "07:16"], ["DAVIS PURPL L", "07:22"],
        ]),
        trip({ route: "93", leader: "005", follower: "002", headway: "/" }, [
          ["DAVIS PURPL L", "07:37+"], ["EMERSON DODGE", "07:45+"], ["HOWARD CALIF", "07:54+"],
          ["TOUHY CALIFNA", "07:56+"], ["DEVON CALIFNA", "08:01"], ["LINCOLN CALIF", "08:05"],
          ["FOSTER ALBANY", "08:09+"], ["LAWRNC KEDZIE", "08:13"], ["IRVING CALIF", "08:19"],
          ["BELMONT CALIF", "08:21+"], ["LOGAN SQ L", "08:27"],
        ]),
        trip({ route: "93", leader: "006", follower: "002", headway: "/" }, [
          ["LOGAN SQ L", "08:45+"], ["BELMONT CALIF", "08:51+"], ["IRVING CALIF", "08:55"],
          ["LAWRNC KEDZIE", "09:02"], ["FOSTER ALBANY", "09:06+"],
        ]),
      ],
      point("09:07", "FOSTER ALBANY"),
      parseRelief("RN P008", "09:06+", "DAVIS PURPL L"),
      { start: "06:16+", end: "09:06+" },
      { startType: "pullout", endType: "relief" },
    ),
    half(
      point("10:15", "N PARK GARAGE"),
      [
        trip({ inService: false }, [["N PARK GARAGE", "10:25"], ["FOSTER ALBANY", "10:25"]]),
        trip({ headway: "/", route: "93" }, [
          ["FOSTER ALBANY", "10:25"], ["LAWRNC KEDZIE", "10:30"], ["IRVING CALIF", "10:37+"],
          ["BELMONT CALIF", "10:41+"], ["LOGAN SQ L", "10:48"],
        ]),
        trip({ route: "93", leader: "006", follower: "008", headway: "19/18+" }, [
          ["LOGAN SQ L", "10:52"], ["BELMONT CALIF", "10:59"], ["IRVING CALIF", "11:02+"],
          ["LAWRNC KEDZIE", "11:11+"], ["FOSTER ALBANY", "11:16+"], ["LINCOLN CALIF", "11:23"],
          ["DEVON CALIFNA", "11:29"], ["TOUHY CALIFNA", "11:33+"], ["HOWARD CALIF", "11:36"],
          ["EMERSON DODGE", "11:46"], ["DAVIS PURPL L", "11:52+"],
        ]),
        trip({ route: "93", leader: "006*", follower: "008", headway: "19/19" }, [
          ["DAVIS PURPL L", "12:05"], ["EMERSON DODGE", "12:14+"], ["HOWARD CALIF", "12:25"],
          ["TOUHY CALIFNA", "12:27"], ["DEVON CALIFNA", "12:32"], ["LINCOLN CALIF", "12:37+"],
          ["FOSTER ALBANY", "12:43"], ["LAWRNC KEDZIE", "12:48+"], ["IRVING CALIF", "12:58"],
          ["BELMONT CALIF", "13:02"], ["LOGAN SQ L", "13:09+"],
        ]),
        trip({ route: "93", leader: "002", follower: "005", headway: "/" }, [
          ["LOGAN SQ L", "13:27+"], ["BELMONT CALIF", "13:35+"], ["IRVING CALIF", "13:39+"],
          ["LAWRNC KEDZIE", "13:49+"], ["FOSTER ALBANY", "13:55"], ["LINCOLN CALIF", "14:01"],
          ["DEVON CALIFNA", "14:06+"], ["TOUHY CALIFNA", "14:11+"], ["HOWARD CALIF", "14:13+"],
          ["EMERSON DODGE", "14:23+"], ["DAVIS PURPL L", "14:29+"],
        ]),
        trip({ route: "93", leader: "002", follower: "005", headway: "/" }, [
          ["DAVIS PURPL L", "14:42"], ["EMERSON DODGE", "14:51"], ["HOWARD CALIF", "15:01+"],
          ["TOUHY CALIFNA", "15:04"], ["DEVON CALIFNA", "15:09"], ["LINCOLN CALIF", "15:14"],
          ["FOSTER ALBANY", "15:20+"],
        ]),
      ],
      point("15:21", "FOSTER ALBANY"),
      parseRelief("RS P008", "15:20+", "LOGAN SQ L"),
      { start: "10:25", end: "15:20+" },
      { startType: "pullout", endType: "relief" },
    ),
  ],
  { effectiveDate: "08/29/2026", reportTime: "06:01", working: "8h12", dutyType: "", page: 1 },
);
