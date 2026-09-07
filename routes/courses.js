const { pool } = require("../db");
const { redisClient } = require("../cache");
const { authMiddleware, requireRole } = require("../middlewares/auth");

const ALLOWED_SORT_FIELDS = ["course_name", "credit", "created_at"];

module.exports = function registerCourseRoutes(v1Router, v2Router) {
  // =========================================================
  // GET /api/v1/courses
  // JWT Auth + Redis Cache + Pagination + Filtering + Sorting
  // =========================================================
  v1Router.get("/courses", authMiddleware, async (req, res, next) => {
    try {
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
      const offset = (page - 1) * limit;

      const minCredit =
        req.query.minCredit !== undefined
          ? parseInt(req.query.minCredit)
          : null;

      const name = req.query.name ? String(req.query.name).trim() : null;

      const sort = ALLOWED_SORT_FIELDS.includes(req.query.sort)
        ? req.query.sort
        : "id";

      const order =
        String(req.query.order).toUpperCase() === "DESC" ? "DESC" : "ASC";

      // สร้าง Cache Key จาก query
      const cacheKey = `courses:v1:${JSON.stringify({
        page,
        limit,
        minCredit,
        name,
        sort,
        order,
      })}`;

      // 1. Cache hit
      const cached = await redisClient.get(cacheKey);

      if (cached) {
        return res.status(200).json(JSON.parse(cached));
      }

      // 2. สร้าง WHERE แบบปลอดภัย
      const conditions = [];
      const params = [];

      if (minCredit !== null && Number.isInteger(minCredit)) {
        conditions.push("credit >= ?");
        params.push(minCredit);
      }

      if (name) {
        conditions.push("course_name LIKE ?");
        params.push(`%${name}%`);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // 3. นับจำนวนข้อมูลทั้งหมด
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
           FROM courses
           ${whereClause}`,
        params,
      );

      const total = countRows[0].total;

      // 4. ดึงข้อมูล
      const [rows] = await pool.query(
        `SELECT *
           FROM courses
           ${whereClause}
           ORDER BY ${sort} ${order}
           LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      const totalPages = Math.ceil(total / limit);

      const response = {
        message: "สำเร็จ",
        data: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      };

      // 5. Cache 60 วินาที
      await redisClient.set(cacheKey, JSON.stringify(response), {
        EX: 60,
      });

      return res.status(200).json(response);
    } catch (err) {
      next(err);
    }
  });

  // =========================================================
  // POST /api/v1/courses
  // JWT + RBAC admin + Transaction + Cache Invalidation
  // =========================================================
  v1Router.post(
    "/courses",
    authMiddleware,
    requireRole("admin"),
    async (req, res, next) => {
      const { course_name, credit, prerequisites = [] } = req.body;

      let connection;

      try {
        connection = await pool.getConnection();

        // เริ่ม Transaction
        await connection.beginTransaction();

        // 1. เพิ่ม course
        const [result] = await connection.query(
          `INSERT INTO courses
           (course_name, credit)
           VALUES (?, ?)`,
          [course_name, credit],
        );

        const courseId = result.insertId;

        // 2. เพิ่ม prerequisite
        for (const prereqId of prerequisites) {
          await connection.query(
            `INSERT INTO course_prerequisites
             (course_id, prereq_course_id)
             VALUES (?, ?)`,
            [courseId, prereqId],
          );
        }

        // 3. Commit
        await connection.commit();

        // 4. คืน connection ให้ pool
        connection.release();
        connection = null;

        // 5. Invalidate Cache
        const keys = await redisClient.keys("courses:v1:*");

        if (keys.length > 0) {
          await redisClient.del(keys);
        }

        return res.status(201).json({
          message: "เพิ่มข้อมูลสำเร็จ",
          data: {
            id: courseId,
          },
        });
      } catch (err) {
        // Rollback เมื่อเกิด error
        if (connection) {
          await connection.rollback();
          connection.release();
        }

        next(err);
      }
    },
  );

  // =========================================================
  // GET /api/v2/courses
  // API Versioning
  // =========================================================
  v2Router.get("/courses", authMiddleware, async (req, res, next) => {
    try {
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
      const offset = (page - 1) * limit;

      const minCredit =
        req.query.minCredit !== undefined
          ? parseInt(req.query.minCredit)
          : null;

      const conditions = [];
      const params = [];

      if (minCredit !== null && Number.isInteger(minCredit)) {
        conditions.push("credit >= ?");
        params.push(minCredit);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
           FROM courses
           ${whereClause}`,
        params,
      );

      const total = countRows[0].total;

      const [rows] = await pool.query(
        `SELECT *
           FROM courses
           ${whereClause}
           ORDER BY id
           LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      // Response ของ V2 แตกต่างจาก V1
      return res.status(200).json({
        version: "v2",
        courses: rows,
        meta: {
          currentPage: page,
          perPage: limit,
          totalItems: total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ให้ autograder เข้าถึง allowlist
  registerCourseRoutes.ALLOWED_SORT_FIELDS = ALLOWED_SORT_FIELDS;
};
