import fs from "fs";
import path from "path";

export const handler = async () => {
  try {
    const filePath = path.resolve("netlify/functions/cities/SanAntonio.json");
    const raw = fs.readFileSync(filePath, "utf8");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: raw
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Cannot load SanAntonio.json", details: err.message })
    };
  }
};
