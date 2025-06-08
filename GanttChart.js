import React from "react";
import Gantt from "frappe-gantt-react";

const GanttChart = ({ tasks, onDateChange }) => {
  const formattedTasks = tasks.map((t, index) => ({
    id: index.toString(),
    name: t.task,
    start: t.startDate,
    end: t.endDate,
    progress: 100,
    custom_class: `task-color-${index}`,
  }));

  return (
    <div className="overflow-x-scroll">
      <Gantt
        tasks={formattedTasks}
        viewMode="Day"
        onDateChange={(task, start, end) => onDateChange(task, start, end)}
      />
    </div>
  );
};

export default GanttChart;
